import type { SupabaseClient } from "@supabase/supabase-js";
import type { PredictionRuleVersion } from "@/lib/types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function rulesFrom(value: unknown, content: string): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : content.split("\n").map((item) => item.trim()).filter(Boolean);
}

function mapRuleRow(raw: unknown): PredictionRuleVersion {
  const row = object(raw);
  const parameters = object(row.parameters);
  const joined = Array.isArray(row.prediction_rule_sets)
    ? object(row.prediction_rule_sets[0])
    : object(row.prediction_rule_sets);
  const content = text(row.content);
  return {
    id: text(row.id),
    name: text(parameters.display_name, text(joined.description, text(joined.name, "予想ルール"))),
    version: text(parameters.semantic_version, String(row.version_number ?? "1")),
    rules: rulesFrom(parameters.rules, content),
    createdAt: text(row.created_at, new Date().toISOString()),
    note: text(row.change_note) || undefined,
    isActive: booleanValue(joined.is_active),
  };
}

async function currentUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("Supabaseへログインしてください。");
  return data.user.id;
}

export async function loadRuleVersions(
  client: SupabaseClient,
): Promise<PredictionRuleVersion[]> {
  const { data, error } = await client
    .from("prediction_rule_versions")
    .select(
      "id, version_number, content, parameters, change_note, created_at, prediction_rule_sets!inner(name, description, is_active)",
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(`予想ルールの読み込みに失敗しました: ${error.message}`);
  return (Array.isArray(data) ? data : []).map(mapRuleRow);
}

export async function saveRuleVersion(
  client: SupabaseClient,
  rule: PredictionRuleVersion,
): Promise<PredictionRuleVersion> {
  const ownerId = await currentUserId(client);
  const storageName = `${rule.name} · v${rule.version}`.slice(0, 120);

  if (rule.isActive) {
    const { error } = await client
      .from("prediction_rule_sets")
      .update({ is_active: false })
      .eq("owner_id", ownerId);
    if (error) throw new Error(`ルール状態の更新に失敗しました: ${error.message}`);
  }

  const { data: existingSet, error: lookupError } = await client
    .from("prediction_rule_sets")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("name", storageName)
    .maybeSingle();
  if (lookupError) throw new Error(`ルールの確認に失敗しました: ${lookupError.message}`);

  let ruleSetId = text(object(existingSet).id);
  if (!ruleSetId) {
    const { data: createdSet, error: setError } = await client
      .from("prediction_rule_sets")
      .insert({
        owner_id: ownerId,
        name: storageName,
        description: rule.name,
        is_active: rule.isActive,
      })
      .select("id")
      .single();
    if (setError) throw new Error(`ルールセットの保存に失敗しました: ${setError.message}`);
    ruleSetId = text(object(createdSet).id);
  } else if (rule.isActive) {
    const { error } = await client
      .from("prediction_rule_sets")
      .update({ is_active: true })
      .eq("id", ruleSetId);
    if (error) throw new Error(`ルールの有効化に失敗しました: ${error.message}`);
  }

  const { data: existingVersion, error: versionLookupError } = await client
    .from("prediction_rule_versions")
    .select("id, version_number, content, parameters, change_note, created_at, prediction_rule_sets!inner(name, description, is_active)")
    .eq("rule_set_id", ruleSetId)
    .eq("version_number", 1)
    .maybeSingle();
  if (versionLookupError) throw new Error(`ルール版の確認に失敗しました: ${versionLookupError.message}`);
  if (existingVersion) return mapRuleRow(existingVersion);

  const { data: createdVersion, error: versionError } = await client
    .from("prediction_rule_versions")
    .insert({
      rule_set_id: ruleSetId,
      version_number: 1,
      status: "published",
      content: rule.rules.join("\n"),
      parameters: {
        semantic_version: rule.version,
        display_name: rule.name,
        rules: rule.rules,
      },
      change_note: rule.note ?? null,
      published_at: new Date().toISOString(),
    })
    .select("id, version_number, content, parameters, change_note, created_at, prediction_rule_sets!inner(name, description, is_active)")
    .single();
  if (versionError) throw new Error(`ルール版の保存に失敗しました: ${versionError.message}`);
  return mapRuleRow(createdVersion);
}

export async function activateRuleVersion(
  client: SupabaseClient,
  ruleId: string,
): Promise<void> {
  const ownerId = await currentUserId(client);
  const { data, error } = await client
    .from("prediction_rule_versions")
    .select("rule_set_id")
    .eq("id", ruleId)
    .single();
  if (error) throw new Error(`ルール版を確認できませんでした: ${error.message}`);
  const ruleSetId = text(object(data).rule_set_id);

  const { error: clearError } = await client
    .from("prediction_rule_sets")
    .update({ is_active: false })
    .eq("owner_id", ownerId);
  if (clearError) throw new Error(`ルール状態の更新に失敗しました: ${clearError.message}`);

  const { error: activateError } = await client
    .from("prediction_rule_sets")
    .update({ is_active: true })
    .eq("id", ruleSetId);
  if (activateError) throw new Error(`ルールを有効化できませんでした: ${activateError.message}`);
}

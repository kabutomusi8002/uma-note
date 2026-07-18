-- Shared master data only. No demo user or betting record is inserted.

insert into public.racecourses (code, name_ja, name_en, display_order)
values
  ('SAPPORO', '札幌', 'Sapporo', 10),
  ('HAKODATE', '函館', 'Hakodate', 20),
  ('FUKUSHIMA', '福島', 'Fukushima', 30),
  ('NIIGATA', '新潟', 'Niigata', 40),
  ('TOKYO', '東京', 'Tokyo', 50),
  ('NAKAYAMA', '中山', 'Nakayama', 60),
  ('CHUKYO', '中京', 'Chukyo', 70),
  ('KYOTO', '京都', 'Kyoto', 80),
  ('HANSHIN', '阪神', 'Hanshin', 90),
  ('KOKURA', '小倉', 'Kokura', 100),
  ('MONBETSU', '門別', 'Monbetsu', 210),
  ('MORIOKA', '盛岡', 'Morioka', 220),
  ('MIZUSAWA', '水沢', 'Mizusawa', 230),
  ('URAWA', '浦和', 'Urawa', 240),
  ('FUNABASHI', '船橋', 'Funabashi', 250),
  ('OI', '大井', 'Oi', 260),
  ('KAWASAKI', '川崎', 'Kawasaki', 270),
  ('KANAZAWA', '金沢', 'Kanazawa', 280),
  ('KASAMATSU', '笠松', 'Kasamatsu', 290),
  ('NAGOYA', '名古屋', 'Nagoya', 300),
  ('SONODA', '園田', 'Sonoda', 310),
  ('HIMEJI', '姫路', 'Himeji', 320),
  ('KOCHI', '高知', 'Kochi', 330),
  ('SAGA', '佐賀', 'Saga', 340),
  ('OBIHIRO', '帯広', 'Obihiro', 350)
on conflict (code) do update set
  name_ja = excluded.name_ja,
  name_en = excluded.name_en,
  display_order = excluded.display_order,
  is_active = true;

insert into public.reflection_categories (
  code, name_ja, description, display_order
)
values
  ('pace', '展開読み', 'ペース・位置取り・展開想定に関する振り返り', 10),
  ('track', '馬場読み', '馬場状態・トラックバイアスに関する振り返り', 20),
  ('key_horse', '軸馬選び', '軸馬の能力・適性・状態評価に関する振り返り', 30),
  ('opponents', '相手選び', '相手・危険人気・穴馬の評価に関する振り返り', 40),
  ('bet_construction', '買い目設計', '券種・組み合わせ・点数に関する振り返り', 50),
  ('staking', '資金配分', '投資額・1点金額・リスク管理に関する振り返り', 60),
  ('decision', '買い／見送り', '買う・見送る判断に関する振り返り', 70),
  ('other', 'その他', '不利・不可抗力を含むその他の振り返り', 80)
on conflict (code) do update set
  name_ja = excluded.name_ja,
  description = excluded.description,
  display_order = excluded.display_order,
  is_active = true;

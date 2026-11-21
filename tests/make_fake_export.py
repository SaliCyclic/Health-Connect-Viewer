"""Builds a synthetic Health Connect export (health_connect_export.db inside a zip)
using the table/column names from AOSP HealthFitness. Values are random."""
import sqlite3, random, math, zipfile, os, uuid, time

random.seed(4)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
db_path = os.path.join(OUT, "health_connect_export.db")
if os.path.exists(db_path):
    os.remove(db_path)
c = sqlite3.connect(db_path)
x = c.execute

META = """row_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid BLOB, last_modified_time INTEGER,
client_record_id TEXT, client_record_version TEXT, device_info_id INTEGER, app_info_id INTEGER,
recording_method INTEGER, dedupe_hash BLOB"""
INTERVAL = "start_time INTEGER, start_zone_offset INTEGER, end_time INTEGER, end_zone_offset INTEGER, local_date INTEGER"
INSTANT = "time INTEGER, zone_offset INTEGER, local_date INTEGER"

x("CREATE TABLE application_info_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, package_name TEXT, app_name TEXT, app_icon BLOB)")
x("INSERT INTO application_info_table(package_name, app_name) VALUES ('com.google.android.apps.fitness','Fit'),('tech.mmarca.openvitals','OpenVitals'),('org.example.watch','OpenWatch')")

def interval(name, extra):
    x(f"CREATE TABLE {name} ({META}, {INTERVAL}, {extra})")
def instant(name, extra):
    x(f"CREATE TABLE {name} ({META}, {INSTANT}, {extra})")

interval("steps_record_table", "count INTEGER")
interval("distance_record_table", "distance REAL")
interval("active_calories_burned_record_table", "energy REAL")
interval("total_calories_burned_record_table", "energy REAL")
interval("floors_climbed_record_table", "floors REAL")
interval("hydration_record_table", "volume REAL")
interval("nutrition_record_table", "energy REAL, protein REAL, total_carbohydrate REAL, total_fat REAL, name TEXT, meal_type INTEGER")
interval("mindfulness_session_record_table", "mindfulness_session_type INTEGER, title TEXT, notes TEXT")
interval("heart_rate_record_table", "dummy INTEGER")
x("CREATE TABLE heart_rate_record_series_table (parent_key INTEGER, beats_per_minute INTEGER, epoch_millis INTEGER)")
interval("sleep_session_record_table", "notes TEXT, title TEXT")
x("CREATE TABLE sleep_stages_table (parent_key INTEGER NOT NULL, stage_start_time INTEGER NOT NULL, stage_end_time INTEGER NOT NULL, stage_type INTEGER NOT NULL)")
interval("exercise_session_record_table", "notes TEXT, exercise_type INTEGER, title TEXT, has_route INTEGER, planned_exercise_session_id BLOB")
x("CREATE TABLE exercise_route_table (parent_key INTEGER NOT NULL, timestamp_millis INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, altitude REAL NOT NULL, horizontal_accuracy REAL NOT NULL, vertical_accuracy REAL NOT NULL)")
instant("weight_record_table", "weight REAL")
instant("body_fat_record_table", "percentage REAL")
instant("height_record_table", "height REAL")
instant("resting_heart_rate_record_table", "beats_per_minute INTEGER")
instant("heart_rate_variability_rmssd_record_table", "heart_rate_variability_millis REAL")
instant("blood_pressure_record_table", "measurement_location TEXT NOT NULL, systolic REAL, diastolic REAL, body_position TEXT NOT NULL")
instant("oxygen_saturation_record_table", "percentage REAL")
instant("respiratory_rate_record_table", "rate REAL")
instant("vo2_max_record_table", "measurement_method INTEGER, vo2_milliliters_per_minute_kilogram REAL")
x("CREATE TABLE preference_table (key TEXT, value TEXT)")

TZ = -4 * 3600  # Halifax, seconds
DAY = 86400000
now = int(time.time() * 1000)
today0 = (now + TZ * 1000) // DAY * DAY - TZ * 1000
N = 420

def ins(table, cols, vals):
    q = ",".join("?" * len(vals))
    cur = x(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({q})", vals)
    return cur.lastrowid

base_i = ["uuid", "last_modified_time", "app_info_id", "start_time", "start_zone_offset", "end_time", "end_zone_offset"]
base_t = ["uuid", "last_modified_time", "app_info_id", "time", "zone_offset"]

w = 84000.0
for d in range(N, -1, -1):
    day0 = today0 - d * DAY
    weekend = ((day0 // DAY) + 4) % 7 in (5, 6)
    # steps: hourly chunks from two sources (Fit + watch) -> double-count risk
    total = int(random.gauss(9000 if not weekend else 6500, 2500))
    for h in range(7, 22):
        s = max(0, int(total / 15 + random.gauss(0, 150)))
        st = day0 + h * 3600000
        ins("steps_record_table", base_i + ["count"], [uuid.uuid4().bytes, st, 3, st, TZ, st + 3600000, TZ, s])
        ins("steps_record_table", base_i + ["count"], [uuid.uuid4().bytes, st, 1, st, TZ, st + 3600000, TZ, int(s * 0.95)])
    ins("distance_record_table", base_i + ["distance"], [uuid.uuid4().bytes, day0, 3, day0 + 8 * 3600000, TZ, day0 + 21 * 3600000, TZ, total * 0.75])
    ins("active_calories_burned_record_table", base_i + ["energy"], [uuid.uuid4().bytes, day0, 3, day0 + 8 * 3600000, TZ, day0 + 21 * 3600000, TZ, total * 0.045 * 1000])
    ins("total_calories_burned_record_table", base_i + ["energy"], [uuid.uuid4().bytes, day0, 3, day0, TZ, day0 + DAY - 1, TZ, (1750 + total * 0.045) * 1000])
    ins("floors_climbed_record_table", base_i + ["floors"], [uuid.uuid4().bytes, day0, 3, day0 + 9 * 3600000, TZ, day0 + 10 * 3600000, TZ, random.randint(2, 20)])
    for k in range(random.randint(3, 7)):
        t = day0 + random.randint(8, 21) * 3600000
        ins("hydration_record_table", base_i + ["volume"], [uuid.uuid4().bytes, t, 2, t, TZ, t + 60000, TZ, random.choice([0.25, 0.33, 0.5])])
    for k in range(3):
        t = day0 + (8 + k * 5) * 3600000
        ins("nutrition_record_table", base_i + ["energy", "protein", "total_carbohydrate", "total_fat", "name", "meal_type"],
            [uuid.uuid4().bytes, t, 2, t, TZ, t + 1800000, TZ, random.gauss(650, 150) * 1000, 30, 70, 20, "Meal", k + 1])
    if random.random() < 0.4:
        t = day0 + 7 * 3600000
        ins("mindfulness_session_record_table", base_i + ["mindfulness_session_type", "title"], [uuid.uuid4().bytes, t, 2, t, TZ, t + random.choice([5, 10, 15]) * 60000, TZ, 1, "Breathing"])
    # heart rate: one record per day, sample every 5 minutes
    hr_id = ins("heart_rate_record_table", base_i, [uuid.uuid4().bytes, day0, 3, day0, TZ, day0 + DAY - 1, TZ])
    rows = []
    for m in range(0, 1440, 5):
        tod = m / 60
        bpm = 58 + 12 * math.sin((tod - 9) / 24 * 2 * math.pi) + (25 if 17 <= tod < 18 and not weekend else 0) + random.gauss(0, 4)
        if tod < 6: bpm -= 6
        rows.append((hr_id, int(bpm), day0 + m * 60000))
    c.executemany("INSERT INTO heart_rate_record_series_table VALUES (?,?,?)", rows)
    t = day0 + 7 * 3600000
    ins("resting_heart_rate_record_table", base_t + ["beats_per_minute"], [uuid.uuid4().bytes, t, 3, t, TZ, int(random.gauss(56, 2))])
    ins("heart_rate_variability_rmssd_record_table", base_t + ["heart_rate_variability_millis"], [uuid.uuid4().bytes, t, 3, t, TZ, random.gauss(48, 7)])
    ins("oxygen_saturation_record_table", base_t + ["percentage"], [uuid.uuid4().bytes, t, 3, t, TZ, random.uniform(94, 99.5)])
    ins("respiratory_rate_record_table", base_t + ["rate"], [uuid.uuid4().bytes, t, 3, t, TZ, random.gauss(14.5, 0.8)])
    if d % 2 == 0:
        w += random.gauss(-15, 180)
        ins("weight_record_table", base_t + ["weight"], [uuid.uuid4().bytes, t, 2, t, TZ, w])
        ins("body_fat_record_table", base_t + ["percentage"], [uuid.uuid4().bytes, t, 2, t, TZ, 22 + (w - 84000) / 1000 * 0.6 + random.gauss(0, 0.4)])
    if d % 3 == 0:
        ins("blood_pressure_record_table", base_t + ["measurement_location", "systolic", "diastolic", "body_position"], [uuid.uuid4().bytes, t, 2, t, TZ, "0", random.gauss(122, 6), random.gauss(79, 4), "0"])
    if d % 14 == 0:
        ins("vo2_max_record_table", base_t + ["measurement_method", "vo2_milliliters_per_minute_kilogram"], [uuid.uuid4().bytes, t, 3, t, TZ, 1, random.gauss(44, 1)])
    # sleep: previous night 23:00 -> 07:00
    st = day0 - 3600000 * random.uniform(0.5, 1.5)
    en = day0 + 3600000 * random.uniform(6.2, 7.8)
    sid = ins("sleep_session_record_table", base_i, [uuid.uuid4().bytes, en, 3, int(st), TZ, int(en), TZ])
    tcur = st
    while tcur < en:
        stg = random.choices([4, 5, 6, 1], [50, 20, 22, 8])[0]
        ln = random.uniform(10, 45) * 60000
        e2 = min(en, tcur + ln)
        x("INSERT INTO sleep_stages_table VALUES (?,?,?,?)", (sid, int(tcur), int(e2), stg))
        tcur = e2
    # workouts
    if not weekend and random.random() < 0.5 or weekend and random.random() < 0.6:
        etype = random.choice([33, 33, 53, 4, 45])
        st = day0 + 17 * 3600000
        dur = random.randint(25, 70) * 60000
        has_route = etype in (33, 53, 4)
        eid = ins("exercise_session_record_table", base_i + ["exercise_type", "title", "has_route"], [uuid.uuid4().bytes, st, 2, st, TZ, st + dur, TZ, etype, None if random.random() < 0.5 else "Evening session", int(has_route)])
        if has_route:
            lat, lon = 44.6488, -63.5752
            ang = random.uniform(0, 6.28)
            pts = []
            n = dur // 5000
            for i in range(n):
                a = ang + i / n * 2 * math.pi
                r = 0.012 * (1 + 0.3 * math.sin(i / n * 6 * math.pi))
                pts.append((eid, st + i * 5000, lat + r * math.sin(a), lon + r * 1.4 * math.cos(a) - 0.0168 * math.cos(ang), 20 + 15 * math.sin(i / n * 4 * math.pi), 5, 5))
            c.executemany("INSERT INTO exercise_route_table VALUES (?,?,?,?,?,?,?)", pts)
x("INSERT INTO height_record_table (uuid,last_modified_time,app_info_id,time,zone_offset,height) VALUES (?,?,?,?,?,?)", (uuid.uuid4().bytes, today0, 2, today0 - 300 * DAY, TZ, 1.78))
c.commit()
c.close()
zp = os.path.join(OUT, "Health Connect.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(db_path, "health_connect_export.db")
print(os.path.getsize(db_path), os.path.getsize(zp))

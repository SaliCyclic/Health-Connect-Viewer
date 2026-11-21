"""Builds a synthetic Health Connect export (health_connect_export.db inside a zip)
using the table/column names from AOSP HealthFitness. Values are random."""
import sqlite3, random, math, zipfile, os, uuid, time, argparse

ap = argparse.ArgumentParser(description="Write a random Health Connect-style export to tests/out/")
ap.add_argument("--days", type=int, default=420, help="days of history (default 420)")
ap.add_argument("--hr-minutes", type=int, default=5, help="minutes between heart-rate samples (default 5)")
ARGS = ap.parse_args()

def make_extra_files(today0):
    """Sample workout files (GPX, TCX, FIT) and an OpenVitals cycle-journal backup."""
    import json, struct, datetime
    start = today0 - 3 * 86400000 + 7 * 3600000   # three days ago, morning (UTC ms)
    pts = []
    for i in range(0, 1800, 10):
        a = i / 1800 * 2 * math.pi
        pts.append((start + i * 1000, 44.65 + 0.01 * math.sin(a), -63.58 + 0.014 * math.cos(a), 30 + 20 * math.sin(2 * a), int(120 + 30 * math.sin(a))))
    # cumulative distance along the track, so the files' own distance fields match their GPS points
    cum = [0.0]
    for (t0, a0, o0, *_), (t1, a1, o1, *_) in zip(pts, pts[1:]):
        r = math.radians
        h = math.sin(r(a1 - a0) / 2) ** 2 + math.cos(r(a0)) * math.cos(r(a1)) * math.sin(r(o1 - o0) / 2) ** 2
        cum.append(cum[-1] + 2 * 6371000 * math.asin(math.sqrt(h)))
    iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    gpx = ['<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>Morning run</name><type>running</type><trkseg>']
    gpx += [f'<trkpt lat="{la}" lon="{lo}"><ele>{el:.1f}</ele><time>{iso(t)}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>' for t, la, lo, el, hr in pts]
    gpx.append("</trkseg></trk></gpx>")
    open(os.path.join(OUT, "morning-run.gpx"), "w").write("\n".join(gpx))
    s2 = start - 86400000
    tcx = ['<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Id>x</Id><Lap><Track>']
    tcx += [f'<Trackpoint><Time>{iso(t - start + s2)}</Time><Position><LatitudeDegrees>{la}</LatitudeDegrees><LongitudeDegrees>{lo}</LongitudeDegrees></Position><AltitudeMeters>{el:.1f}</AltitudeMeters><DistanceMeters>{cum[i]:.1f}</DistanceMeters><HeartRateBpm><Value>{hr}</Value></HeartRateBpm></Trackpoint>' for i, (t, la, lo, el, hr) in enumerate(pts)]
    tcx.append("</Track></Lap></Activity></Activities></TrainingCenterDatabase>")
    open(os.path.join(OUT, "bike.tcx"), "w").write("\n".join(tcx))
    # FIT: definition + data messages for 'record' (20) and 'session' (18)
    FIT_EPOCH = 631065600
    s3 = start - 2 * 86400000
    body = bytearray()
    body += bytes([0x40, 0, 0]) + struct.pack("<H", 20) + bytes([6]) + bytes([253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84, 3, 1, 0x02, 5, 4, 0x86])
    semi = 2 ** 31 / 180
    for i, (t, la, lo, el, hr) in enumerate(pts):
        ts = (t - start + s3) // 1000 - FIT_EPOCH
        body += bytes([0x00]) + struct.pack("<IiiHBI", ts, int(la * semi), int(lo * semi), int((el + 500) * 5), hr, int(cum[i] * 100))
    body += bytes([0x41, 0, 0]) + struct.pack("<H", 18) + bytes([5]) + bytes([253, 4, 0x86, 2, 4, 0x86, 5, 1, 0x00, 7, 4, 0x86, 9, 4, 0x86])
    st3 = s3 // 1000 - FIT_EPOCH
    body += bytes([0x01]) + struct.pack("<IIBII", st3 + 1800, st3, 1, 1800 * 1000, int(cum[-1] * 100))
    header = struct.pack("<BBHI4sH", 14, 0x20, 2132, len(body), b".FIT", 0)
    open(os.path.join(OUT, "watch-run.fit"), "wb").write(header + body + b"\x00\x00")
    # OpenVitals cycle journal (format 1)
    ents = []
    for k in range(60):
        d = datetime.date.fromtimestamp(today0 / 1000) - datetime.timedelta(days=k * 2)
        ents.append({"date": d.isoformat(), "bleedingNone": False, "pain": random.randint(1, 5), "mood": random.randint(1, 5), "energy": random.randint(1, 5),
                     "symptoms": random.sample(["cramps", "headache", "bloating", "fatigue", "acne", "mood_changes"], random.randint(0, 3)),
                     "notes": "Felt tired" if k % 9 == 0 else "", "disturbances": [], "updatedAt": today0})
    json.dump({"format": 1, "exportedAt": today0, "entries": sorted(ents, key=lambda e: e["date"]), "exclusions": [], "profile": {"contexts": []}},
              open(os.path.join(OUT, "openvitals-cycle-journal.json"), "w"), indent=1)

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
# the user's app priority per data category (activity: watch first, then Fit)
x("CREATE TABLE health_data_category_priority_table (row_id INTEGER PRIMARY KEY AUTOINCREMENT, health_data_category INTEGER UNIQUE, app_id_priority_order TEXT NOT NULL)")
x("INSERT INTO health_data_category_priority_table (health_data_category, app_id_priority_order) VALUES (1, '3,1'), (5, '3,1')")
interval("menstruation_period_record_table", "dummy INTEGER")
instant("menstruation_flow_record_table", "flow INTEGER")

TZ = -4 * 3600  # Halifax, seconds
DAY = 86400000
now = int(time.time() * 1000)
today0 = (now + TZ * 1000) // DAY * DAY - TZ * 1000
N = ARGS.days

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
    for m in range(0, 1440, ARGS.hr_minutes):
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
    # the phone app (Fit) logs most of the same nights too, slightly shorter: must not be double counted
    if random.random() < 0.7:
        ins("sleep_session_record_table", base_i, [uuid.uuid4().bytes, en, 1, int(st + 600000), TZ, int(en - 300000), TZ])
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
# periods every ~28-31 days, 5 days long, with flow records
pd = today0 - N * DAY + 3 * DAY
while pd < today0:
    ins("menstruation_period_record_table", base_i, [uuid.uuid4().bytes, pd, 2, pd, TZ, pd + 5 * DAY - 1, TZ])
    for k, f in enumerate([2, 3, 2, 1, 1]):
        ins("menstruation_flow_record_table", base_t + ["flow"], [uuid.uuid4().bytes, pd, 2, pd + k * DAY + 8 * 3600000, TZ, f])
    pd += random.randint(27, 31) * DAY
x("INSERT INTO height_record_table (uuid,last_modified_time,app_info_id,time,zone_offset,height) VALUES (?,?,?,?,?,?)", (uuid.uuid4().bytes, today0, 2, today0 - 300 * DAY, TZ, 1.78))
c.commit()
c.close()
zp = os.path.join(OUT, "Health Connect.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(db_path, "health_connect_export.db")
print(os.path.getsize(db_path), os.path.getsize(zp))
make_extra_files(today0)

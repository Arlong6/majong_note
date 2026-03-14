#!/usr/bin/env python3
"""
Injects test data into the WKWebView localStorage SQLite DB for screenshots/testing.
Usage: python3 scripts_inject_test_data.py [tab]
  tab: calendar (default), stats, players
"""
import sqlite3, json, os, sys
from datetime import datetime, timedelta
import random
import subprocess

UDID = "E30E76A2-7DC4-42C0-9F1C-E57604AFDBDD"
tab = sys.argv[1] if len(sys.argv) > 1 else "calendar"

def u16(s): return s.encode('utf-16-le')

# Terminate app first
subprocess.run(["xcrun", "simctl", "terminate", UDID, "com.arlong.mahjong"], 
               capture_output=True)
import time; time.sleep(2)

# Get container
result = subprocess.run(
    ["xcrun", "simctl", "get_app_container", UDID, "com.arlong.mahjong", "data"],
    capture_output=True, text=True
)
container = result.stdout.strip()
print(f"Container: {container}")

# Find DB
import glob
db_pattern = f"{container}/Library/WebKit/**/LocalStorage/localstorage.sqlite3"
dbs = glob.glob(db_pattern, recursive=True)
if not dbs:
    print("ERROR: DB not found. Launch app first to initialize DB.")
    exit(1)
DB = dbs[0]
print(f"DB: {DB}")

now = datetime.now()
players_pool = ['阿明', '小華', '大強', '阿花', '小李']
random.seed(42)

records = []
idx = 1
for days_ago in range(90, 6, -1):
    d = now - timedelta(days=days_ago)
    if d.weekday() in [4, 5, 6] or (days_ago % 7 == 0):
        for _ in range(random.randint(1, 2)):
            rtype = 'win' if random.random() > 0.42 else 'loss'
            amount = random.choice([100, 150, 200, 300, 500, 800, 1000])
            players = random.sample(players_pool, random.randint(2, 3))
            records.append({
                "id": idx * 1000 + random.randint(1, 999),
                "date": d.strftime("%Y-%m-%dT%H:%M:%S") + ".000Z",
                "amount": amount, "type": rtype, "note": "",
                "participants": players
            })
            idx += 1

for i in range(5, -1, -1):
    d = now - timedelta(days=i)
    records.append({
        "id": 99000 + i,
        "date": d.strftime("%Y-%m-%dT%H:%M:%S") + ".000Z",
        "amount": random.choice([300, 500, 800, 1000]),
        "type": "win",
        "note": "今天手氣不錯！" if i == 0 else "",
        "participants": random.sample(players_pool, 3)
    })

records.sort(key=lambda r: r['date'])

for ext in ['-wal', '-shm']:
    p = DB + ext
    if os.path.exists(p): os.remove(p)

conn = sqlite3.connect(DB)
c = conn.cursor()
c.execute("DELETE FROM ItemTable")
c.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", 
          ("mahjong_records", u16(json.dumps(records, ensure_ascii=False))))
c.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)",
          ("mahjong_players", u16(json.dumps(players_pool, ensure_ascii=False))))
c.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ("mahjong_onboarded", u16("1")))
c.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ("__tab", u16(tab)))
conn.commit()
conn.close()

wins = [r for r in records if r['type'] == 'win']
losses = [r for r in records if r['type'] == 'loss']
print(f"Injected {len(records)} records (W:{len(wins)}/L:{len(losses)}), tab={tab}")
print("Now run: xcrun simctl launch E30E76A2-7DC4-42C0-9F1C-E57604AFDBDD com.arlong.mahjong")

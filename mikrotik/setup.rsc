# ============================================================================
# Timeless WiFi - one-time router setup. Replace YOUR-BACKEND-HOST (e.g. timeless-wifi.koyeb.app) first,
# then paste into New Terminal (or: /import setup.rsc).
# ============================================================================

# 1) Let unpaid devices reach the payment backend (HTTP + HTTPS)
/ip hotspot walled-garden add dst-host=YOUR-BACKEND-HOST comment="Timeless WiFi backend"
/ip hotspot walled-garden ip add action=accept dst-host=YOUR-BACKEND-HOST comment="Timeless WiFi backend (https)"

# 2) User profiles with speed caps (rate-limit is upload/download as seen by the client).
#    Optional: the sync script creates these automatically from packages.js on first sale,
#    and updates the cap if you change a package's speed on the server.
:foreach p in={"Lite_3M=3M/3M";"Profile_30M=5M/5M";"Profile_1H=5M/5M";"Profile_3H=5M/5M";"Profile_Night=5M/5M";"Profile_24H=5M/5M";"Profile_1W=5M/5M";"Profile_1M=5M/5M"} do={
  :local eq [:find $p "="]
  :local name [:pick $p 0 $eq]
  :local rl [:pick $p ($eq + 1) [:len $p]]
  :if ([:len [/ip hotspot user profile find name=$name]] = 0) do={
    /ip hotspot user profile add name=$name shared-users=1 rate-limit=$rl keepalive-timeout=5m
  } else={
    /ip hotspot user profile set [find name=$name] rate-limit=$rl
  }
}

# 3) Run the sync script every 10 seconds (create the "timeless-sync" script first)
/system scheduler add name=timeless-sync interval=10s start-time=startup \
    on-event="/system script run timeless-sync" policy=read,write,test,policy \
    comment="Timeless WiFi: pull paid codes from backend"

# 4) Recommended: allow PAP+CHAP so both auto-login and manual codes work
# /ip hotspot profile set [find default=no] login-by=http-chap,http-pap,cookie

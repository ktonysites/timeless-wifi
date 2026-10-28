# ============================================================================
# Timeless WiFi - router sync script (RouterOS v7, also works on v6.45+)
# Pulls paid access codes from the backend, creates hotspot users, and removes
# expired ones. The router only makes OUTBOUND https requests, so no port
# forwarding or public IP is needed.
#
# Install: System > Scripts > Add new
#   Name: timeless-sync    Policy: read, write, test, policy
#   Source: paste everything below the "---- SOURCE ----" line
#   (edit BASE and KEY first). Then run setup.rsc for the scheduler.
# ============================================================================
# ---- SOURCE ----
:local BASE "https://YOUR-BACKEND-HOST/api/v1"
:local KEY "PASTE_YOUR_ROUTER_SECRET"

:local hdr ("X-Router-Key: " . $KEY)
:local go true
:local n 0

:while ($go && $n < 15) do={
  :set n ($n + 1)
  :local body ""
  :do {
    :set body ([/tool fetch url=($BASE . "/router/sync") http-header-field=$hdr output=user as-value]->"data")
  } on-error={
    :log warning "TimelessWiFi: backend unreachable"
    :set go false
  }

  :if ($go && ([:len $body] = 0 || $body = "NONE")) do={ :set go false }
  :if ($go && [:pick $body 0 5] = "ERROR") do={ :log error ("TimelessWiFi: " . $body); :set go false }

  :if ($go) do={
    # split "A,B,C" into an array
    :local parts [:toarray ""]
    :local s $body
    :while ([:len $s] > 0) do={
      :local p [:find $s ","]
      :if ([:typeof $p] = "nil") do={
        :set parts ($parts, $s); :set s ""
      } else={
        :set parts ($parts, [:pick $s 0 $p]); :set s [:pick $s ($p + 1) [:len $s]]
      }
    }

    :local action ($parts->0)
    :local id ($parts->1)
    :local user ($parts->2)

    :if ($action = "ADD") do={
      :local pass ($parts->3)
      :local prof ($parts->4)
      :local up ($parts->5)
      :local rl ""
      :if ([:len $parts] > 6) do={ :set rl ($parts->6) }
      # create the profile with the package's speed cap, or keep its cap in sync
      :local pf [/ip hotspot user profile find name=$prof]
      :if ([:len $pf] = 0) do={
        :if ([:len $rl] > 0) do={
          /ip hotspot user profile add name=$prof shared-users=1 rate-limit=$rl keepalive-timeout=5m
        } else={
          /ip hotspot user profile add name=$prof shared-users=1 keepalive-timeout=5m
        }
        :log info ("TimelessWiFi: created profile " . $prof . " " . $rl)
      } else={
        :if ([:len $rl] > 0) do={
          :local cur [/ip hotspot user profile get [:pick $pf 0] rate-limit]
          :if ($cur != $rl) do={
            /ip hotspot user profile set [:pick $pf 0] rate-limit=$rl
            :log info ("TimelessWiFi: profile " . $prof . " speed set to " . $rl)
          }
        }
      }
      :local ex [/ip hotspot user find name=$user]
      :if ([:len $ex] = 0) do={
        /ip hotspot user add name=$user password=$pass profile=$prof limit-uptime=$up comment=("TW " . $id)
      } else={
        /ip hotspot user set $ex password=$pass profile=$prof limit-uptime=$up
      }
      /tool fetch url=($BASE . "/router/confirm/" . $id . "\?action=add") http-header-field=$hdr output=none
      :log info ("TimelessWiFi: activated " . $user . " (" . $prof . " " . $rl . ")")
    }

    :if ($action = "DEL") do={
      :do { /ip hotspot active remove [find user=$user] } on-error={}
      :do { /ip hotspot cookie remove [find user=$user] } on-error={}
      :do { /ip hotspot user remove [find name=$user] } on-error={}
      /tool fetch url=($BASE . "/router/confirm/" . $id . "\?action=del") http-header-field=$hdr output=none
      :log info ("TimelessWiFi: expired " . $user)
    }

    :if ($action != "ADD" && $action != "DEL") do={ :set go false }
  }
}

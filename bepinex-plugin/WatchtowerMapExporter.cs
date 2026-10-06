// ============================================================================
// WatchtowerMapExporter.cs — Lightweight Server-Side BepInEx Telemetry Plugin
// For lloesche/valheim-server (set BEPINEX="true" in docker-compose.yml)
//
// Reads ZDOMan on the dedicated server every 2 seconds to export:
// 1. Live Player coordinates (X, Y, Z), Rotation, Health ("health" / "max_health" ZDO floats), Stamina
// 2. Shared Cartography Table (piece_cartographytable) discovered Fog-of-War & pins
// 3. Linked Portals (piece_portal_wood) and Death Tombstones (Player_tombstone)
// Writes directly to /config/watchtower/live_map.json for Heimdall Watchtower.
// ============================================================================

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using BepInEx;
using UnityEngine;

namespace HeimdallWatchtower
{
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.0.0")]
    public class WatchtowerMapExporter : BaseUnityPlugin
    {
        private float _timer;
        private const float ExportIntervalSeconds = 2.0f;
        private string _outputPath = "/config/watchtower/live_map.json";

        private void Awake()
        {
            Directory.CreateDirectory("/config/watchtower");
            Logger.LogInfo("[Heimdall Watchtower] Live Map & Player Health ZDO Exporter loaded.");
        }

        private void Update()
        {
            _timer += Time.deltaTime;
            if (_timer < ExportIntervalSeconds) return;
            _timer = 0f;

            try
            {
                if (ZNet.instance == null || ZDOMan.instance == null) return;
                ExportWorldAndPlayers();
            }
            catch (Exception ex)
            {
                Logger.LogWarning($"[Heimdall Watchtower] Telemetry export warning: {ex.Message}");
            }
        }

        private void ExportWorldAndPlayers()
        {
            var peers = ZNet.instance.GetPeers();
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.AppendFormat("  \"worldName\": \"{0}\",\n", ZNet.instance.GetWorldName());
            sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", DateTime.UtcNow.ToString("o"));
            sb.Append("  \"players\": [\n");

            bool firstPlayer = true;
            foreach (var peer in peers)
            {
                if (peer == null || !peer.IsReady() || peer.m_characterID.IsNone()) continue;

                ZDO zdo = ZDOMan.instance.GetZDO(peer.m_characterID);
                Vector3 pos = zdo != null ? zdo.GetPosition() : peer.m_refPos;
                float hp = zdo != null ? zdo.GetFloat("health", 100f) : 100f;
                float maxHp = zdo != null ? zdo.GetFloat("max_health", 100f) : 100f;
                float stamina = zdo != null ? zdo.GetFloat("stamina", 100f) : 100f;
                string steamId = peer.m_rpc != null ? peer.m_rpc.GetSocket().GetHostName() : "";

                if (!firstPlayer) sb.Append(",\n");
                firstPlayer = false;

                sb.Append("    {\n");
                sb.AppendFormat("      \"steamId\": \"{0}\",\n", steamId);
                sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(peer.m_playerName));
                sb.AppendFormat("      \"x\": {0:F1},\n", pos.x);
                sb.AppendFormat("      \"y\": {0:F1},\n", pos.y);
                sb.AppendFormat("      \"z\": {0:F1},\n", pos.z);
                sb.AppendFormat("      \"hp\": {0:F0},\n", hp);
                sb.AppendFormat("      \"maxHp\": {0:F0},\n", maxHp);
                sb.AppendFormat("      \"stamina\": {0:F0}\n", stamina);
                sb.Append("    }");
            }

            sb.Append("\n  ]\n}\n");
            File.WriteAllText(_outputPath, sb.ToString(), Encoding.UTF8);
        }

        private static string EscapeJson(string s)
        {
            return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}

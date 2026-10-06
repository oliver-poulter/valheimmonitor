// ============================================================================
// WatchtowerMapExporter.cs — Version-Independent Reflection BepInEx Plugin
// Auto-installed into /config/bepinex/plugins/WatchtowerMapExporter.dll
//
// Uses reflection against assembly_valheim (ZNet & ZDOMan) so it never breaks
// across Valheim updates. Exports live player (X, Y, Z) coordinates, Health,
// MaxHealth, and Stamina to /config/watchtower/live_map.json every 2 seconds.
// ============================================================================

using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using BepInEx;
using UnityEngine;

namespace HeimdallWatchtower
{
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.2.0")]
    public class WatchtowerMapExporter : BaseUnityPlugin
    {
        private float _timer;
        private const float ExportIntervalSeconds = 2.0f;
        private const string OutputPath = "/config/watchtower/live_map.json";

        private Type _znetType;
        private Type _zdoManType;

        private void Awake()
        {
            try
            {
                Directory.CreateDirectory("/config/watchtower");
                WriteBootstrapStatus("plugin_loaded_booting_world");
                Logger.LogInfo("[Heimdall Watchtower] Live Map & Health ZDO Exporter v1.2.0 initialized.");
            }
            catch (Exception ex)
            {
                Logger.LogWarning("[Heimdall Watchtower] Init warning: " + ex.Message);
            }
        }

        private void WriteBootstrapStatus(string status)
        {
            try
            {
                var sb = new StringBuilder();
                sb.Append("{\n");
                sb.AppendFormat("  \"pluginStatus\": \"{0}\",\n", EscapeJson(status));
                sb.Append("  \"pluginVersion\": \"1.2.0\",\n");
                sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", DateTime.UtcNow.ToString("o"));
                sb.Append("  \"players\": []\n}\n");
                File.WriteAllText(OutputPath, sb.ToString(), Encoding.UTF8);
            }
            catch
            {
                // Ignore I/O error if directory not ready
            }
        }

        private void Update()
        {
            _timer += Time.deltaTime;
            if (_timer < ExportIntervalSeconds) return;
            _timer = 0f;

            try
            {
                ExportWorldAndPlayers();
            }
            catch
            {
                // Ignore transient startup frame exceptions
            }
        }

        private void ResolveTypes()
        {
            if (_znetType != null && _zdoManType != null) return;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (_znetType == null) _znetType = asm.GetType("ZNet");
                if (_zdoManType == null) _zdoManType = asm.GetType("ZDOMan");
            }
        }

        private void ExportWorldAndPlayers()
        {
            ResolveTypes();
            if (_znetType == null || _zdoManType == null)
            {
                WriteBootstrapStatus("waiting_for_assembly_valheim");
                return;
            }

            var znetInstance = _znetType.GetProperty("instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null)
                            ?? _znetType.GetField("m_instance", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);
            var zdoManInstance = _zdoManType.GetProperty("instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null)
                              ?? _zdoManType.GetField("s_instance", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);

            if (znetInstance == null || zdoManInstance == null)
            {
                WriteBootstrapStatus("loading_world_save");
                return;
            }

            string worldName = _znetType.GetMethod("GetWorldName")?.Invoke(znetInstance, null) as string ?? "Dedicated";
            var peersObj = _znetType.GetMethod("GetPeers")?.Invoke(znetInstance, null) as IEnumerable;
            var getZdoMethod = _zdoManType.GetMethod("GetZDO", new[] { _znetType.Assembly.GetType("ZDOID") });

            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"pluginStatus\": \"active\",\n");
            sb.Append("  \"pluginVersion\": \"1.2.0\",\n");
            sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
            sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", DateTime.UtcNow.ToString("o"));
            sb.Append("  \"players\": [\n");

            bool first = true;
            if (peersObj != null)
            {
                foreach (var peer in peersObj)
                {
                    if (peer == null) continue;
                    var peerType = peer.GetType();
                    bool isReady = (bool)(peerType.GetMethod("IsReady")?.Invoke(peer, null) ?? false);
                    if (!isReady) continue;

                    string playerName = peerType.GetField("m_playerName")?.GetValue(peer) as string ?? "Viking";
                    object refPosObj = peerType.GetField("m_refPos")?.GetValue(peer);
                    object charIdObj = peerType.GetField("m_characterID")?.GetValue(peer);

                    float x = 0f, y = 0f, z = 0f;
                    if (refPosObj != null)
                    {
                        var vType = refPosObj.GetType();
                        x = Convert.ToSingle(vType.GetField("x")?.GetValue(refPosObj) ?? 0f);
                        y = Convert.ToSingle(vType.GetField("y")?.GetValue(refPosObj) ?? 0f);
                        z = Convert.ToSingle(vType.GetField("z")?.GetValue(refPosObj) ?? 0f);
                    }

                    float hp = 100f, maxHp = 100f, stamina = 100f;
                    if (charIdObj != null && getZdoMethod != null)
                    {
                        object zdo = getZdoMethod.Invoke(zdoManInstance, new[] { charIdObj });
                        if (zdo != null)
                        {
                            var zdoType = zdo.GetType();
                            object zdoPos = zdoType.GetMethod("GetPosition")?.Invoke(zdo, null);
                            if (zdoPos != null)
                            {
                                var zpType = zdoPos.GetType();
                                x = Convert.ToSingle(zpType.GetField("x")?.GetValue(zdoPos) ?? x);
                                y = Convert.ToSingle(zpType.GetField("y")?.GetValue(zdoPos) ?? y);
                                z = Convert.ToSingle(zpType.GetField("z")?.GetValue(zdoPos) ?? z);
                            }

                            var getFloatStr = zdoType.GetMethod("GetFloat", new[] { typeof(string), typeof(float) });
                            if (getFloatStr != null)
                            {
                                hp = Convert.ToSingle(getFloatStr.Invoke(zdo, new object[] { "health", 100f }));
                                maxHp = Convert.ToSingle(getFloatStr.Invoke(zdo, new object[] { "max_health", 100f }));
                                stamina = Convert.ToSingle(getFloatStr.Invoke(zdo, new object[] { "stamina", 100f }));
                            }
                        }
                    }

                    string steamId = "";
                    object socketObj = peerType.GetField("m_socket")?.GetValue(peer);
                    if (socketObj != null)
                    {
                        steamId = socketObj.GetType().GetMethod("GetHostName")?.Invoke(socketObj, null) as string ?? "";
                    }

                    if (!first) sb.Append(",\n");
                    first = false;

                    sb.Append("    {\n");
                    sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(steamId));
                    sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(playerName));
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", x);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", y);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", z);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0}\n", stamina);
                    sb.Append("    }");
                }
            }

            sb.Append("\n  ]\n}\n");
            File.WriteAllText(OutputPath, sb.ToString(), Encoding.UTF8);
        }

        private static string EscapeJson(string s)
        {
            return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}

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
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.3.0")]
    public class WatchtowerMapExporter : BaseUnityPlugin
    {
        private float _timer;
        private const float ExportIntervalSeconds = 2.0f;
        private const string OutputPath = "/config/watchtower/live_map.json";
        private const string TerrainOutputPath = "/config/watchtower/world_terrain.json";

        private Type _znetType;
        private Type _zdoManType;
        private Type _worldGenType;
        private Type _zoneSysType;

        private bool _terrainExported;
        private int _terrainRow;
        private const int GridSize = 200;
        private const float WorldRadius = 10500f;
        private byte[] _biomeBytes;
        private byte[] _heightBytes;
        private MethodInfo _getBiomeMethod;
        private int _getBiomeParamCount;
        private MethodInfo _getHeightMethod;
        private int _getHeightParamCount;

        private void Awake()
        {
            try
            {
                Directory.CreateDirectory("/config/watchtower");
                WriteBootstrapStatus("plugin_loaded_booting_world");
                Logger.LogInfo("[Heimdall Watchtower] Live Map, Terrain & Health ZDO Exporter v1.3.0 initialized.");
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
                sb.Append("  \"pluginVersion\": \"1.3.0\",\n");
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
            if (!_terrainExported)
            {
                try
                {
                    StepTerrainExport();
                }
                catch
                {
                    // Ignore transient reflection errors while world is still initializing
                }
            }

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
            if (_znetType != null && _zdoManType != null && _worldGenType != null) return;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (_znetType == null) _znetType = asm.GetType("ZNet");
                if (_zdoManType == null) _zdoManType = asm.GetType("ZDOMan");
                if (_worldGenType == null) _worldGenType = asm.GetType("WorldGenerator");
                if (_zoneSysType == null) _zoneSysType = asm.GetType("ZoneSystem");
            }
        }

        private void StepTerrainExport()
        {
            ResolveTypes();
            if (_worldGenType == null || _znetType == null) return;

            var wgInstance = _worldGenType.GetProperty("instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null)
                          ?? _worldGenType.GetField("m_instance", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);
            var znetInstance = _znetType.GetProperty("instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null)
                            ?? _znetType.GetField("m_instance", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);

            if (wgInstance == null || znetInstance == null) return;

            if (_getBiomeMethod == null)
            {
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (m.Name == "GetBiome")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length >= 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getBiomeMethod = m;
                            _getBiomeParamCount = ps.Length;
                            break;
                        }
                    }
                }
            }

            if (_getHeightMethod == null)
            {
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (m.Name == "GetHeight")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length >= 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getHeightMethod = m;
                            _getHeightParamCount = ps.Length;
                            break;
                        }
                    }
                }
            }

            if (_getBiomeMethod == null || _getHeightMethod == null)
            {
                _terrainExported = true;
                return;
            }

            if (_biomeBytes == null)
            {
                _biomeBytes = new byte[GridSize * GridSize];
                _heightBytes = new byte[GridSize * GridSize];
                _terrainRow = 0;
            }

            // Process 8 rows per Update frame (~1,600 samples/frame) so server tick is never delayed
            int rowsToProcess = 8;
            while (rowsToProcess > 0 && _terrainRow < GridSize)
            {
                float wz = WorldRadius - ((_terrainRow + 0.5f) / GridSize) * (WorldRadius * 2f);
                for (int col = 0; col < GridSize; col++)
                {
                    float wx = -WorldRadius + ((col + 0.5f) / GridSize) * (WorldRadius * 2f);
                    int idx = _terrainRow * GridSize + col;

                    if ((wx * wx + wz * wz) > (WorldRadius * WorldRadius))
                    {
                        _biomeBytes[idx] = 0;
                        _heightBytes[idx] = 0;
                        continue;
                    }

                    object[] bArgs = _getBiomeParamCount == 4
                        ? new object[] { wx, wz, 0.02f, false }
                        : new object[] { wx, wz };
                    int rawBiome = Convert.ToInt32(_getBiomeMethod.Invoke(wgInstance, bArgs));
                    _biomeBytes[idx] = MapBiomeEnumToCode(rawBiome);

                    object[] hArgs = _getHeightParamCount == 3
                        ? new object[] { wx, wz, null }
                        : new object[] { wx, wz };
                    float rawH = Convert.ToSingle(_getHeightMethod.Invoke(wgInstance, hArgs));
                    // Sea level in Valheim is 30m. Map [10m..137.5m] -> [0..255], so sea level 30m == 40
                    int qH = (int)Math.Round((rawH - 10f) * 2f);
                    if (qH < 0) qH = 0;
                    if (qH > 255) qH = 255;
                    _heightBytes[idx] = (byte)qH;
                }
                _terrainRow++;
                rowsToProcess--;
            }

            if (_terrainRow >= GridSize)
            {
                _terrainExported = true;
                string worldName = _znetType.GetMethod("GetWorldName")?.Invoke(znetInstance, null) as string ?? "Dedicated";
                var sb = new StringBuilder();
                sb.Append("{\n");
                sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
                sb.AppendFormat("  \"gridSize\": {0},\n", GridSize);
                sb.Append("  \"seaLevelByte\": 40,\n");
                sb.AppendFormat("  \"biomesBase64\": \"{0}\",\n", Convert.ToBase64String(_biomeBytes));
                sb.AppendFormat("  \"heightsBase64\": \"{0}\",\n", Convert.ToBase64String(_heightBytes));
                sb.Append("  \"landmarks\": [\n");
                AppendZoneLandmarks(sb);
                sb.Append("\n  ]\n}\n");
                File.WriteAllText(TerrainOutputPath, sb.ToString(), Encoding.UTF8);
                Logger.LogInfo("[Heimdall Watchtower] Exported exact WorldGenerator terrain & biome map to " + TerrainOutputPath);
            }
        }

        private void AppendZoneLandmarks(StringBuilder sb)
        {
            bool first = true;
            try
            {
                if (_zoneSysType == null) return;
                var zsInstance = _zoneSysType.GetProperty("instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null, null)
                              ?? _zoneSysType.GetField("m_instance", BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);
                if (zsInstance == null) return;

                var locDict = _zoneSysType.GetField("m_locationInstances", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(zsInstance) as IDictionary;
                if (locDict == null) return;

                int count = 0;
                foreach (var val in locDict.Values)
                {
                    if (val == null) continue;
                    var vType = val.GetType();
                    object locObj = vType.GetField("m_location")?.GetValue(val);
                    object posObj = vType.GetField("m_position")?.GetValue(val);
                    if (locObj == null || posObj == null) continue;

                    string prefabName = locObj.GetType().GetField("m_prefabName")?.GetValue(locObj) as string ?? "";
                    if (string.IsNullOrEmpty(prefabName)) continue;

                    string label = null;
                    string icon = "📍";
                    string ltype = "boss";
                    if (prefabName == "StartTemple") { label = "Sacrificial Stones"; icon = "🏛️"; ltype = "spawn"; }
                    else if (prefabName.StartsWith("Eikthyrnir")) { label = "EIKTHYR"; icon = "🦌"; }
                    else if (prefabName.StartsWith("GDKing")) { label = "THE ELDER"; icon = "🌲"; }
                    else if (prefabName.StartsWith("Bonemass")) { label = "BONEMASS"; icon = "☠️"; }
                    else if (prefabName.StartsWith("Dragonqueen")) { label = "MODER"; icon = "🐉"; }
                    else if (prefabName.StartsWith("GoblinKing")) { label = "YAGLUTH"; icon = "👑"; }
                    else if (prefabName.StartsWith("Mistlands_DvergrBossEntrance")) { label = "THE QUEEN"; icon = "🪲"; }
                    else if (prefabName.StartsWith("CharredFortress") || prefabName.StartsWith("Fader")) { label = "FADER"; icon = "🔥"; }
                    else if (prefabName.StartsWith("Vendor_BlackForest")) { label = "HALDOR"; icon = "💰"; ltype = "trader"; }
                    else if (prefabName.StartsWith("Hildir_camp")) { label = "HILDIR"; icon = "⛺"; ltype = "trader"; }

                    if (label == null) continue;

                    var pType = posObj.GetType();
                    float x = Convert.ToSingle(pType.GetField("x")?.GetValue(posObj) ?? 0f);
                    float z = Convert.ToSingle(pType.GetField("z")?.GetValue(posObj) ?? 0f);

                    if (!first) sb.Append(",\n");
                    first = false;
                    sb.Append("    { ");
                    sb.AppendFormat(CultureInfo.InvariantCulture, "\"id\": \"lm-{0}\", \"type\": \"{1}\", \"name\": \"{2}\", \"icon\": \"{3}\", \"x\": {4:F0}, \"z\": {5:F0}",
                        count++, ltype, EscapeJson(label), EscapeJson(icon), x, z);
                    sb.Append(" }");
                    if (count >= 35) break;
                }
            }
            catch
            {
                // Ignore if ZoneSystem layout differs
            }
        }

        private static byte MapBiomeEnumToCode(int b)
        {
            // Valheim Heightmap.Biome bitflags:
            // Meadows=1, Swamp=2, Mountain=4, BlackForest=8, Plains=16, AshLands=32, DeepNorth=64, Ocean=256, Mistlands=512
            switch (b)
            {
                case 1: return 1;   // Meadows
                case 8: return 2;   // Black Forest
                case 2: return 3;   // Swamp
                case 4: return 4;   // Mountains
                case 16: return 5;  // Plains
                case 512: return 6; // Mistlands
                case 32: return 7;  // Ashlands
                case 64: return 8;  // Deep North
                case 256: return 0; // Ocean
                default: return 0;
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
            sb.Append("  \"pluginVersion\": \"1.3.0\",\n");
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

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
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.4.0")]
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
                Logger.LogInfo("[Heimdall Watchtower] Live Map, Terrain & Health ZDO Exporter v1.4.0 initialized.");
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
                sb.Append("  \"pluginVersion\": \"1.4.0\",\n");
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

        private class PeerVitalState
        {
            public float LastX;
            public float LastY;
            public float LastZ;
            public float LastHp = 25f;
            public float Stamina = 50f;
            public float Heading;
            public bool Initialized;
        }

        private readonly System.Collections.Generic.Dictionary<string, PeerVitalState> _vitalStates
            = new System.Collections.Generic.Dictionary<string, PeerVitalState>();

        private static int GetValheimStableHashCode(string str)
        {
            int num = 5381;
            int num2 = num;
            for (int i = 0; i < str.Length && str[i] != '\0'; i += 2)
            {
                num = ((num << 5) + num) ^ str[i];
                if (i == str.Length - 1 || str[i + 1] == '\0')
                    break;
                num2 = ((num2 << 5) + num2) ^ str[i + 1];
            }
            return num + num2 * 1566083941;
        }

        private static float ReadZdoFloat(object zdo, string keyName, float defaultVal)
        {
            if (zdo == null) return defaultVal;
            var zdoType = zdo.GetType();

            // 1. Try ZDO.GetFloat(int hash, float defaultValue) — used by Valheim ZDOVars
            var getFloatInt = zdoType.GetMethod("GetFloat", new[] { typeof(int), typeof(float) });
            if (getFloatInt != null)
            {
                int hash = GetValheimStableHashCode(keyName);
                float val = Convert.ToSingle(getFloatInt.Invoke(zdo, new object[] { hash, defaultVal }));
                if (Math.Abs(val - defaultVal) > 0.001f) return val;
            }

            // 2. Try ZDO.GetFloat(string name, float defaultValue)
            var getFloatStr = zdoType.GetMethod("GetFloat", new[] { typeof(string), typeof(float) });
            if (getFloatStr != null)
            {
                float val = Convert.ToSingle(getFloatStr.Invoke(zdo, new object[] { keyName, defaultVal }));
                if (Math.Abs(val - defaultVal) > 0.001f) return val;
            }

            return defaultVal;
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

            // Find ZDOMan.GetZDO(ZDOID) without depending on which assembly defines struct ZDOID
            MethodInfo getZdoMethod = null;
            foreach (var m in _zdoManType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
            {
                if (m.Name == "GetZDO" && m.GetParameters().Length == 1)
                {
                    getZdoMethod = m;
                    break;
                }
            }

            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"pluginStatus\": \"active\",\n");
            sb.Append("  \"pluginVersion\": \"1.4.0\",\n");
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

                    string playerName = peerType.GetField("m_playerName", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(peer) as string ?? "Viking";
                    object refPosObj = peerType.GetField("m_refPos", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(peer);
                    object charIdObj = peerType.GetField("m_characterID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(peer);

                    float x = 0f, y = 0f, z = 0f;
                    if (refPosObj != null)
                    {
                        var vType = refPosObj.GetType();
                        x = Convert.ToSingle(vType.GetField("x")?.GetValue(refPosObj) ?? 0f);
                        y = Convert.ToSingle(vType.GetField("y")?.GetValue(refPosObj) ?? 0f);
                        z = Convert.ToSingle(vType.GetField("z")?.GetValue(refPosObj) ?? 0f);
                    }

                    string steamId = "";
                    object socketObj = peerType.GetField("m_socket", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(peer);
                    if (socketObj != null)
                    {
                        steamId = socketObj.GetType().GetMethod("GetHostName")?.Invoke(socketObj, null) as string ?? "";
                    }
                    string stateKey = !string.IsNullOrEmpty(steamId) ? steamId : playerName;

                    float rawHp = -1f;
                    float rawMaxHp = -1f;
                    float rawStamina = -1f;
                    float rawMaxStamina = -1f;
                    float zdoNoise = 0f;

                    if (charIdObj != null && getZdoMethod != null)
                    {
                        object zdo = getZdoMethod.Invoke(zdoManInstance, new[] { charIdObj });
                        if (zdo != null)
                        {
                            var zdoType = zdo.GetType();
                            object zdoPos = zdoType.GetMethod("GetPosition")?.Invoke(zdo, null)
                                         ?? zdoType.GetField("m_position", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(zdo);
                            if (zdoPos != null)
                            {
                                var zpType = zdoPos.GetType();
                                x = Convert.ToSingle(zpType.GetField("x")?.GetValue(zdoPos) ?? x);
                                y = Convert.ToSingle(zpType.GetField("y")?.GetValue(zdoPos) ?? y);
                                z = Convert.ToSingle(zpType.GetField("z")?.GetValue(zdoPos) ?? z);
                            }

                            rawHp = ReadZdoFloat(zdo, "health", -1f);
                            rawMaxHp = ReadZdoFloat(zdo, "max_health", -1f);
                            rawStamina = ReadZdoFloat(zdo, "stamina", -1f);
                            rawMaxStamina = ReadZdoFloat(zdo, "max_stamina", -1f);
                            zdoNoise = ReadZdoFloat(zdo, "noise", 0f);
                        }
                    }

                    // Resolve real Health & MaxHealth (Valheim base unfed health is 25 HP)
                    float maxHp = rawMaxHp > 0f ? rawMaxHp : (rawHp > 25f ? rawHp : 25f);
                    float hp = rawHp > 0f ? rawHp : maxHp;
                    if (hp > maxHp) maxHp = hp;

                    // Resolve or compute real-time Stamina & MaxStamina from live ZDO movement & action noise
                    PeerVitalState pState;
                    if (!_vitalStates.TryGetValue(stateKey, out pState))
                    {
                        pState = new PeerVitalState();
                        _vitalStates[stateKey] = pState;
                    }

                    float dx = pState.Initialized ? (x - pState.LastX) : 0f;
                    float dy = pState.Initialized ? (y - pState.LastY) : 0f;
                    float dz = pState.Initialized ? (z - pState.LastZ) : 0f;
                    float horizDist = (float)Math.Sqrt(dx * dx + dz * dz);
                    float speedMps = horizDist / ExportIntervalSeconds;
                    if (horizDist > 0.4f)
                    {
                        pState.Heading = (float)(((Math.Atan2(dx, dz) * 180.0) / Math.PI + 360.0) % 360.0);
                    }

                    float maxStamina = rawMaxStamina > 0f
                        ? rawMaxStamina
                        : (maxHp <= 25.5f ? 50f : (float)Math.Round(50f + (maxHp - 25f) * 0.85f));

                    float stamina;
                    if (rawStamina >= 0f)
                    {
                        stamina = rawStamina;
                    }
                    else
                    {
                        if (!pState.Initialized)
                        {
                            pState.Stamina = maxStamina;
                        }
                        // Drain stamina when sprinting (>4.3 m/s), climbing steep terrain, swimming, or in noisy combat/harvesting
                        float drain = 0f;
                        if (speedMps > 4.3f && speedMps < 14f)
                        {
                            drain += (speedMps - 4.0f) * 4.2f;
                        }
                        if (dy > 0.7f && horizDist < 20f)
                        {
                            drain += dy * 2.5f;
                        }
                        if (y < 29.3f && speedMps > 0.4f)
                        {
                            drain += 9.0f;
                        }
                        if (zdoNoise >= 20f)
                        {
                            drain += Math.Min(22f, zdoNoise * 0.35f);
                        }
                        if (hp < pState.LastHp - 0.5f)
                        {
                            drain += 12f;
                        }

                        if (drain > 0.5f)
                        {
                            pState.Stamina = Math.Max(4f, pState.Stamina - drain);
                        }
                        else
                        {
                            float regen = speedMps < 0.4f ? 16f : 9f;
                            pState.Stamina = Math.Min(maxStamina, pState.Stamina + regen);
                        }
                        stamina = Math.Min(maxStamina, pState.Stamina);
                    }

                    string activity = "Exploring";
                    if (pState.Initialized && hp < pState.LastHp - 0.5f)
                    {
                        activity = "In Combat (Taking Damage!)";
                    }
                    else if (zdoNoise >= 30f)
                    {
                        activity = "Combat / Harvesting";
                    }
                    else if (y < 29.3f && speedMps > 0.4f)
                    {
                        activity = "Swimming / Sailing";
                    }
                    else if (speedMps > 8.0f)
                    {
                        activity = string.Format(CultureInfo.InvariantCulture, "Sailing ({0:F1} m/s)", speedMps);
                    }
                    else if (speedMps > 4.3f)
                    {
                        activity = string.Format(CultureInfo.InvariantCulture, "Sprinting ({0:F1} m/s)", speedMps);
                    }
                    else if (speedMps > 0.5f)
                    {
                        activity = string.Format(CultureInfo.InvariantCulture, "Hiking ({0:F1} m/s)", speedMps);
                    }
                    else
                    {
                        activity = "Resting / Encamped";
                    }

                    pState.LastX = x;
                    pState.LastY = y;
                    pState.LastZ = z;
                    pState.LastHp = hp;
                    pState.Initialized = true;

                    if (!first) sb.Append(",\n");
                    first = false;

                    sb.Append("    {\n");
                    sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(steamId));
                    sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(playerName));
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", x);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", y);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", z);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"heading\": {0:F0},\n", pState.Heading);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0},\n", stamina);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxStamina\": {0:F0},\n", maxStamina);
                    sb.AppendFormat("      \"activity\": \"{0}\"\n", EscapeJson(activity));
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

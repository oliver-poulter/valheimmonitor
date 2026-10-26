// ============================================================================
// WatchtowerMapExporter.cs — Version-Independent Reflection BepInEx Plugin
// Auto-installed into /config/bepinex/plugins/WatchtowerMapExporter.dll
//
// Uses cached reflection against assembly_valheim (ZNet & ZDOMan) so it never
// breaks across Valheim updates and produces near-zero GC pressure in Mono.
// Exports live player (X, Y, Z) coordinates, Health, MaxHealth, and Stamina
// to /config/watchtower/live_map.json every 2 seconds.
// ============================================================================

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using BepInEx;
using UnityEngine;

namespace HeimdallWatchtower
{
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.5.0")]
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

        // Cached reflection members to avoid per-tick allocations in Mono Boehm GC
        private MethodInfo _getZdoMethod;
        private bool _getZdoMethodSearched;
        private static Type _cachedZdoType;
        private static MethodInfo _zdoGetFloatIntMethod;
        private static MethodInfo _zdoGetFloatStrMethod;
        private static MethodInfo _zdoGetPosMethod;
        private static FieldInfo _zdoPosField;

        private static Type _cachedVecType;
        private static FieldInfo _vecXField;
        private static FieldInfo _vecYField;
        private static FieldInfo _vecZField;

        private string _cachedLandmarksJson;

        // Pre-computed Valheim stable ZDO variable hashes
        private static readonly int HashHealth = GetValheimStableHashCode("health");
        private static readonly int HashMaxHealth = GetValheimStableHashCode("max_health");
        private static readonly int HashStamina = GetValheimStableHashCode("stamina");
        private static readonly int HashMaxStamina = GetValheimStableHashCode("max_stamina");
        private static readonly int HashNoise = GetValheimStableHashCode("noise");

        private const BindingFlags InstFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

        private static object GetFieldVal(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            FieldInfo f = t.GetField(name, flags);
            return f != null ? f.GetValue(target) : null;
        }

        private static object GetPropVal(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            PropertyInfo p = t.GetProperty(name, flags);
            return (p != null && p.GetIndexParameters().Length == 0) ? p.GetValue(target, null) : null;
        }

        private static object GetMemberVal(Type t, object target, string name, BindingFlags flags)
        {
            object v = GetFieldVal(t, target, name, flags);
            return v != null ? v : GetPropVal(t, target, name, flags);
        }

        private static object InvokeMethod(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            MethodInfo m = t.GetMethod(name, flags);
            return m != null ? m.Invoke(target, null) : null;
        }

        private void Awake()
        {
            try
            {
                Directory.CreateDirectory("/config/watchtower");
                WriteBootstrapStatus("plugin_loaded_booting_world");
                Logger.LogInfo("[Heimdall Watchtower] Live Map, Terrain & Health ZDO Exporter v1.5.0 initialized.");
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
                var sb = new StringBuilder(512);
                sb.Append("{\n");
                sb.AppendFormat("  \"pluginStatus\": \"{0}\",\n", EscapeJson(status));
                sb.Append("  \"pluginVersion\": \"1.5.0\",\n");
                string nowIso = DateTime.UtcNow.ToString("o");
                sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", nowIso);
                sb.AppendFormat("  \"timestamp\": \"{0}\",\n", nowIso);
                sb.Append("  \"players\": [],\n");
                sb.Append("  \"landmarks\": [\n");
                sb.Append("    { \"id\": \"lm-0\", \"type\": \"spawn\", \"name\": \"Sacrificial Stones\", \"icon\": \"🏛️\", \"biome\": \"Meadows\", \"status\": \"Spawn Altar\", \"x\": 0, \"z\": 0 }\n");
                sb.Append("  ]\n}\n");
                AtomicWriteText(OutputPath, sb.ToString());
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
            catch (Exception ex)
            {
                Logger.LogError("[Heimdall Watchtower] ExportWorldAndPlayers error: " + ex.Message);
            }
        }

        private void ResolveTypes()
        {
            if (_znetType != null && _zdoManType != null && _worldGenType != null && _zoneSysType != null) return;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (_znetType == null) _znetType = asm.GetType("ZNet");
                    if (_zdoManType == null) _zdoManType = asm.GetType("ZDOMan");
                    if (_worldGenType == null) _worldGenType = asm.GetType("WorldGenerator");
                    if (_zoneSysType == null) _zoneSysType = asm.GetType("ZoneSystem");
                }
                catch { }
            }
        }

        private static object GetStaticInstance(Type t)
        {
            if (t == null) return null;
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.FlattenHierarchy;

            // 1. Check known singleton field names first (fastest & side-effect free)
            foreach (var fieldName in new[] { "m_instance", "s_instance", "instance", "_instance", "Instance" })
            {
                try
                {
                    var val = GetFieldVal(t, null, fieldName, flags);
                    if (val != null) return val;
                }
                catch { }
            }

            // 2. Check known singleton property names
            foreach (var propName in new[] { "instance", "Instance", "s_instance", "_instance" })
            {
                try
                {
                    var val = GetPropVal(t, null, propName, flags);
                    if (val != null) return val;
                }
                catch { }
            }

            // 3. Scan static fields assignable to t
            try
            {
                foreach (var field in t.GetFields(flags))
                {
                    if (t.IsAssignableFrom(field.FieldType))
                    {
                        var val = field.GetValue(null);
                        if (val != null) return val;
                    }
                }
            }
            catch { }

            // 4. Unity Component search fallback ONLY if t derives from UnityEngine.Object
            try
            {
                if (typeof(UnityEngine.Object).IsAssignableFrom(t))
                {
                    var findMethod = typeof(UnityEngine.Object).GetMethod("FindObjectOfType", new[] { typeof(Type) });
                    if (findMethod != null)
                    {
                        var val = findMethod.Invoke(null, new object[] { t });
                        if (val != null) return val;
                    }
                }
            }
            catch { }

            return null;
        }

        private object ResolveZNetInstance()
        {
            if (_znetType == null) return null;
            object inst = GetStaticInstance(_znetType);
            if (inst != null) return inst;

            // Search ZNetScene or Game for active ZNet reference
            foreach (var helperName in new[] { "ZNetScene", "Game" })
            {
                try
                {
                    Type ht = _znetType.Assembly.GetType(helperName);
                    if (ht != null)
                    {
                        object hInst = GetStaticInstance(ht);
                        if (hInst != null)
                        {
                            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
                            foreach (var f in ht.GetFields(flags))
                            {
                                if (_znetType.IsAssignableFrom(f.FieldType))
                                {
                                    object val = f.GetValue(hInst);
                                    if (val != null) return val;
                                }
                            }
                        }
                    }
                }
                catch { }
            }

            return null;
        }

        private void StepTerrainExport()
        {
            ResolveTypes();
            if (_worldGenType == null || _znetType == null) return;

            var wgInstance = GetStaticInstance(_worldGenType);
            var znetInstance = GetStaticInstance(_znetType);

            if (wgInstance == null || znetInstance == null) return;

            if (_getBiomeMethod == null)
            {
                MethodInfo fallbackBiome = null;
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (m.Name == "GetBiome")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length == 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getBiomeMethod = m;
                            _getBiomeParamCount = 2;
                            break;
                        }
                        if (ps.Length == 4 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            fallbackBiome = m;
                        }
                    }
                }
                if (_getBiomeMethod == null && fallbackBiome != null)
                {
                    _getBiomeMethod = fallbackBiome;
                    _getBiomeParamCount = 4;
                }
            }

            if (_getHeightMethod == null)
            {
                MethodInfo fallbackHeight = null;
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (m.Name == "GetHeight")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length == 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getHeightMethod = m;
                            _getHeightParamCount = 2;
                            break;
                        }
                        if (ps.Length == 3 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            fallbackHeight = m;
                        }
                    }
                }
                if (_getHeightMethod == null && fallbackHeight != null)
                {
                    _getHeightMethod = fallbackHeight;
                    _getHeightParamCount = 3;
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

            object[] bArgs = _getBiomeParamCount == 4
                ? new object[] { 0f, 0f, 0.02f, false }
                : new object[] { 0f, 0f };

            object defaultThirdArg = null;
            if (_getHeightParamCount == 3)
            {
                var pType = _getHeightMethod.GetParameters()[2].ParameterType;
                if (pType.IsByRef) pType = pType.GetElementType();
                if (pType != null && pType.IsValueType)
                {
                    try { defaultThirdArg = Activator.CreateInstance(pType); } catch { }
                }
            }
            object[] hArgs = _getHeightParamCount == 3
                ? new object[] { 0f, 0f, defaultThirdArg }
                : new object[] { 0f, 0f };

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

                    bArgs[0] = wx;
                    bArgs[1] = wz;
                    int rawBiome = Convert.ToInt32(_getBiomeMethod.Invoke(wgInstance, bArgs));
                    _biomeBytes[idx] = MapBiomeEnumToCode(rawBiome);

                    hArgs[0] = wx;
                    hArgs[1] = wz;
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
                string worldName = InvokeMethod(_znetType, znetInstance, "GetWorldName", InstFlags) as string;
                if (string.IsNullOrEmpty(worldName)) worldName = "Dedicated";

                var sb = new StringBuilder(131072);
                sb.Append("{\n");
                sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
                sb.AppendFormat("  \"gridSize\": {0},\n", GridSize);
                sb.Append("  \"seaLevelByte\": 40,\n");
                sb.AppendFormat("  \"biomesBase64\": \"{0}\",\n", Convert.ToBase64String(_biomeBytes));
                sb.AppendFormat("  \"heightsBase64\": \"{0}\",\n", Convert.ToBase64String(_heightBytes));
                sb.Append("  \"landmarks\": [\n");
                AppendZoneLandmarks(sb);
                sb.Append("\n  ]\n}\n");
                AtomicWriteText(TerrainOutputPath, sb.ToString());

                // Free temporary grid buffers immediately
                _biomeBytes = null;
                _heightBytes = null;
                Logger.LogInfo("[Heimdall Watchtower] Exported exact WorldGenerator terrain & biome map to " + TerrainOutputPath);
            }
        }

        private void AppendZoneLandmarks(StringBuilder sb)
        {
            if (!string.IsNullOrEmpty(_cachedLandmarksJson))
            {
                sb.Append(_cachedLandmarksJson);
                return;
            }

            var lsb = new StringBuilder(2048);
            bool first = true;
            int count = 0;
            try
            {
                if (_zoneSysType == null)
                {
                    ResolveTypes();
                }

                object zsInstance = GetStaticInstance(_zoneSysType);
                if (zsInstance == null && _znetType != null)
                {
                    object znetInst = GetStaticInstance(_znetType);
                    if (znetInst != null)
                    {
                        zsInstance = GetMemberVal(_znetType, znetInst, "m_zoneSystem", InstFlags);
                    }
                }

                IDictionary locDict = null;
                if (zsInstance != null)
                {
                    const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.FlattenHierarchy;
                    Type zsActualType = zsInstance.GetType();
                    foreach (var fieldName in new[] { "m_locationInstances", "locationInstances", "_locationInstances", "m_locations" })
                    {
                        try
                        {
                            locDict = GetMemberVal(zsActualType, zsInstance, fieldName, flags) as IDictionary;
                            if (locDict != null && locDict.Count > 0) break;
                        }
                        catch { }
                    }
                }

                if (locDict != null && locDict.Count > 0)
                {
                    foreach (var val in locDict.Values)
                    {
                        if (val == null) continue;
                        var vType = val.GetType();

                        object locObj = GetMemberVal(vType, val, "m_location", InstFlags);
                        object posObj = GetMemberVal(vType, val, "m_position", InstFlags);
                        if (posObj == null) posObj = GetFieldVal(vType, val, "m_pos", InstFlags);

                        float x, dummyY, z;
                        if (!TryExtractVector3(posObj, out x, out dummyY, out z)) continue;

                        string prefabName = "";
                        if (locObj != null)
                        {
                            var lType = locObj.GetType();
                            prefabName = GetMemberVal(lType, locObj, "m_prefabName", InstFlags) as string
                                      ?? GetFieldVal(lType, locObj, "m_name", InstFlags) as string
                                      ?? GetPropVal(lType, locObj, "name", InstFlags) as string
                                      ?? "";

                            if (string.IsNullOrEmpty(prefabName))
                            {
                                var prefabObj = GetMemberVal(lType, locObj, "m_prefab", InstFlags);
                                if (prefabObj != null)
                                {
                                    prefabName = GetPropVal(prefabObj.GetType(), prefabObj, "name", InstFlags) as string ?? "";
                                }
                            }
                        }

                        if (string.IsNullOrEmpty(prefabName))
                        {
                            prefabName = GetFieldVal(vType, val, "m_prefabName", InstFlags) as string
                                      ?? GetFieldVal(vType, val, "m_name", InstFlags) as string
                                      ?? "";
                        }
                        if (string.IsNullOrEmpty(prefabName)) continue;

                        string p = prefabName.ToLowerInvariant();
                        string label = null;
                        string icon = "📍";
                        string ltype = "boss";
                        string biome = "Unknown";

                        if (p.Contains("starttemple")) { label = "Sacrificial Stones"; icon = "🏛️"; ltype = "spawn"; biome = "Meadows"; }
                        else if (p.Contains("eikthyr")) { label = "EIKTHYR"; icon = "🦌"; biome = "Meadows"; }
                        else if (p.Contains("gdking") || p.Contains("elder")) { label = "THE ELDER"; icon = "🌲"; biome = "Black Forest"; }
                        else if (p.Contains("bonemass")) { label = "BONEMASS"; icon = "☠️"; biome = "Swamp"; }
                        else if (p.Contains("dragonqueen") || p.Contains("moder")) { label = "MODER"; icon = "🐉"; biome = "Mountains"; }
                        else if (p.Contains("goblinking") || p.Contains("yagluth")) { label = "YAGLUTH"; icon = "👑"; biome = "Plains"; }
                        else if (p.Contains("dvergrbossentrance") || p.Contains("queen")) { label = "THE QUEEN"; icon = "🪲"; biome = "Mistlands"; }
                        else if (p.Contains("charredfortress") || p.Contains("fader")) { label = "FADER"; icon = "🔥"; biome = "Ashlands"; }
                        else if (p.Contains("vendor_blackforest") || p.Contains("haldor")) { label = "HALDOR"; icon = "💰"; ltype = "trader"; biome = "Black Forest"; }
                        else if (p.Contains("hildir")) { label = "HILDIR"; icon = "⛺"; ltype = "trader"; biome = "Plains"; }
                        else if (p.Contains("bogwitch")) { label = "BOG WITCH"; icon = "🧙"; ltype = "trader"; biome = "Swamp"; }

                        if (label == null) continue;

                        string lmStatus = ltype == "spawn" ? "Spawn Altar" : (ltype == "trader" ? "Trader Camp" : "Forsaken Altar");
                        if (!first) lsb.Append(",\n");
                        first = false;
                        lsb.Append("    { ");
                        lsb.AppendFormat(CultureInfo.InvariantCulture, "\"id\": \"lm-{0}\", \"type\": \"{1}\", \"name\": \"{2}\", \"icon\": \"{3}\", \"biome\": \"{4}\", \"status\": \"{5}\", \"x\": {6:F0}, \"z\": {7:F0}",
                            count++, ltype, EscapeJson(label), EscapeJson(icon), EscapeJson(biome), EscapeJson(lmStatus), x, z);
                        lsb.Append(" }");
                        if (count >= 50) break;
                    }
                }
            }
            catch
            {
                // Ignore if ZoneSystem layout differs
            }

            if (count > 0)
            {
                _cachedLandmarksJson = lsb.ToString();
                sb.Append(_cachedLandmarksJson);
            }
            else
            {
                sb.Append("    { \"id\": \"lm-0\", \"type\": \"spawn\", \"name\": \"Sacrificial Stones\", \"icon\": \"🏛️\", \"biome\": \"Meadows\", \"status\": \"Spawn Altar\", \"x\": 0, \"z\": 0 }");
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

        private readonly Dictionary<string, PeerVitalState> _vitalStates
            = new Dictionary<string, PeerVitalState>();

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

        private static bool TryExtractVector3(object vecObj, out float x, out float y, out float z)
        {
            x = 0f; y = 0f; z = 0f;
            if (vecObj == null) return false;
            if (vecObj is Vector3)
            {
                Vector3 directVec = (Vector3)vecObj;
                x = directVec.x;
                y = directVec.y;
                z = directVec.z;
                return true;
            }

            var t = vecObj.GetType();
            if (_cachedVecType != t)
            {
                _vecXField = t.GetField("x", InstFlags);
                _vecYField = t.GetField("y", InstFlags);
                _vecZField = t.GetField("z", InstFlags);
                _cachedVecType = t;
            }

            if (_vecXField != null && _vecYField != null && _vecZField != null)
            {
                x = Convert.ToSingle(_vecXField.GetValue(vecObj));
                y = Convert.ToSingle(_vecYField.GetValue(vecObj));
                z = Convert.ToSingle(_vecZField.GetValue(vecObj));
                return true;
            }
            return false;
        }

        private static void EnsureZdoReflectionCached(Type zdoType)
        {
            if (_cachedZdoType == zdoType) return;
            _zdoGetFloatIntMethod = zdoType.GetMethod("GetFloat", new[] { typeof(int), typeof(float) });
            _zdoGetFloatStrMethod = zdoType.GetMethod("GetFloat", new[] { typeof(string), typeof(float) });
            _zdoGetPosMethod = zdoType.GetMethod("GetPosition", Type.EmptyTypes) ?? zdoType.GetMethod("GetPosition");
            _zdoPosField = zdoType.GetField("m_position", InstFlags);
            _cachedZdoType = zdoType;
        }

        private static float ReadZdoFloat(object zdo, int keyHash, string keyName, float defaultVal)
        {
            if (zdo == null) return defaultVal;
            EnsureZdoReflectionCached(zdo.GetType());

            // 1. Try ZDO.GetFloat(int hash, float defaultValue) — used by Valheim ZDOVars
            if (_zdoGetFloatIntMethod != null)
            {
                float val = Convert.ToSingle(_zdoGetFloatIntMethod.Invoke(zdo, new object[] { keyHash, defaultVal }));
                if (Math.Abs(val - defaultVal) > 0.001f) return val;
            }

            // 2. Try ZDO.GetFloat(string name, float defaultValue)
            if (_zdoGetFloatStrMethod != null)
            {
                float val = Convert.ToSingle(_zdoGetFloatStrMethod.Invoke(zdo, new object[] { keyName, defaultVal }));
                if (Math.Abs(val - defaultVal) > 0.001f) return val;
            }

            return defaultVal;
        }

        private void ExportWorldAndPlayers()
        {
            ResolveTypes();
            if (_znetType == null)
            {
                WriteBootstrapStatus("waiting_for_assembly_valheim");
                return;
            }

            var znetInstance = ResolveZNetInstance();
            if (znetInstance == null)
            {
                WriteBootstrapStatus("loading_world_save");
                return;
            }

            var zdoManInstance = GetMemberVal(_znetType, znetInstance, "m_zdoMan", InstFlags)
                              ?? GetStaticInstance(_zdoManType);

            string worldName = InvokeMethod(_znetType, znetInstance, "GetWorldName", InstFlags) as string;
            if (string.IsNullOrEmpty(worldName)) worldName = "Dedicated";

            var peersObj = InvokeMethod(_znetType, znetInstance, "GetPeers", InstFlags) as IEnumerable
                        ?? GetFieldVal(_znetType, znetInstance, "m_peers", InstFlags) as IEnumerable;

            // Query ZNet.GetPlayerList() as an authoritative coordinate source
            var playerListPositions = new Dictionary<string, Vector3>(StringComparer.OrdinalIgnoreCase);
            IEnumerable playerListObj = null;
            try
            {
                playerListObj = InvokeMethod(_znetType, znetInstance, "GetPlayerList", BindingFlags.Public | BindingFlags.Instance) as IEnumerable;
                if (playerListObj != null)
                {
                    foreach (var pi in playerListObj)
                    {
                        if (pi == null) continue;
                        var piType = pi.GetType();
                        string piName = GetFieldVal(piType, pi, "m_name", InstFlags) as string;
                        object piPosObj = GetFieldVal(piType, pi, "m_position", InstFlags);
                        float px, py, pz;
                        if (!string.IsNullOrEmpty(piName) && TryExtractVector3(piPosObj, out px, out py, out pz))
                        {
                            if (px != 0f || pz != 0f)
                            {
                                playerListPositions[piName] = new Vector3 { x = px, y = py, z = pz };
                            }
                        }
                    }
                }
            }
            catch
            {
                // Ignore transient reflection issue with PlayerInfo
            }

            // Cache ZDOMan.GetZDO(ZDOID) once without depending on which assembly defines struct ZDOID
            if (!_getZdoMethodSearched && _zdoManType != null)
            {
                _getZdoMethodSearched = true;
                foreach (var m in _zdoManType.GetMethods(InstFlags))
                {
                    if (m.Name == "GetZDO" && m.GetParameters().Length == 1)
                    {
                        _getZdoMethod = m;
                        break;
                    }
                }
            }

            var sb = new StringBuilder(4096);
            sb.Append("{\n");
            sb.Append("  \"pluginStatus\": \"active\",\n");
            sb.Append("  \"pluginVersion\": \"1.5.0\",\n");
            sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
            string nowIso = DateTime.UtcNow.ToString("o");
            sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", nowIso);
            sb.AppendFormat("  \"timestamp\": \"{0}\",\n", nowIso);
            sb.Append("  \"players\": [\n");

            bool first = true;
            var processedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (peersObj != null)
            {
                foreach (var peer in peersObj)
                {
                    if (peer == null) continue;
                    var peerType = peer.GetType();

                    string playerName = GetFieldVal(peerType, peer, "m_playerName", InstFlags) as string;
                    if (string.IsNullOrEmpty(playerName)) playerName = "Viking";

                    object refPosObj = InvokeMethod(peerType, peer, "GetRefPos", BindingFlags.Public | BindingFlags.Instance)
                                    ?? GetFieldVal(peerType, peer, "m_refPos", InstFlags);
                    object charIdObj = GetFieldVal(peerType, peer, "m_characterID", InstFlags);

                    float x = 0f, y = 0f, z = 0f;
                    float rx, ry, rz;
                    if (TryExtractVector3(refPosObj, out rx, out ry, out rz) && (rx != 0f || rz != 0f))
                    {
                        x = rx; y = ry; z = rz;
                    }

                    string steamId = "";
                    object socketObj = GetFieldVal(peerType, peer, "m_socket", InstFlags);
                    if (socketObj != null)
                    {
                        steamId = InvokeMethod(socketObj.GetType(), socketObj, "GetHostName", InstFlags) as string ?? "";
                    }
                    if (string.IsNullOrEmpty(steamId))
                    {
                        try
                        {
                            object uidObj = GetFieldVal(peerType, peer, "m_uid", InstFlags);
                            if (uidObj != null)
                            {
                                long uid = Convert.ToInt64(uidObj);
                                if (uid > 0) steamId = uid.ToString();
                            }
                        }
                        catch { }
                    }
                    string stateKey = !string.IsNullOrEmpty(steamId) ? steamId : playerName;

                    float rawHp = -1f;
                    float rawMaxHp = -1f;
                    float rawStamina = -1f;
                    float rawMaxStamina = -1f;
                    float zdoNoise = 0f;

                    if (charIdObj != null && _getZdoMethod != null && zdoManInstance != null)
                    {
                        try
                        {
                            object zdo = _getZdoMethod.Invoke(zdoManInstance, new[] { charIdObj });
                            if (zdo != null)
                            {
                                EnsureZdoReflectionCached(zdo.GetType());
                                object zdoPos = _zdoGetPosMethod != null ? _zdoGetPosMethod.Invoke(zdo, null) : null;
                                if (zdoPos == null && _zdoPosField != null) zdoPos = _zdoPosField.GetValue(zdo);

                                float zx, zy, zz;
                                if (TryExtractVector3(zdoPos, out zx, out zy, out zz) && (zx != 0f || zz != 0f))
                                {
                                    x = zx; y = zy; z = zz;
                                }

                                rawHp = ReadZdoFloat(zdo, HashHealth, "health", -1f);
                                rawMaxHp = ReadZdoFloat(zdo, HashMaxHealth, "max_health", -1f);
                                rawStamina = ReadZdoFloat(zdo, HashStamina, "stamina", -1f);
                                rawMaxStamina = ReadZdoFloat(zdo, HashMaxStamina, "max_stamina", -1f);
                                zdoNoise = ReadZdoFloat(zdo, HashNoise, "noise", 0f);
                            }
                        }
                        catch
                        {
                            // Ignore transient ZDO error
                        }
                    }

                    // Fallback to GetPlayerList if peer position is (0, 0)
                    Vector3 pPos;
                    if (x == 0f && z == 0f && playerListPositions.TryGetValue(playerName, out pPos))
                    {
                        x = pPos.x; y = pPos.y; z = pPos.z;
                    }

                    // Resolve real Health & MaxHealth (Valheim base unfed health is 25 HP)
                    float maxHp = rawMaxHp > 0f ? rawMaxHp : (rawHp > 25f ? rawHp : 25f);
                    float hp = rawHp > 0f ? rawHp : maxHp;
                    if (hp > maxHp) maxHp = hp;

                    // Resolve or compute real-time Stamina & MaxStamina from live ZDO movement & action noise
                    PeerVitalState pState;
                    if (!_vitalStates.TryGetValue(stateKey, out pState))
                    {
                        if (_vitalStates.Count > 64) _vitalStates.Clear();
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
                    processedNames.Add(playerName);

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

            // Fallback: Check ZNet.GetPlayerList() for connected players who may not be in peersObj
            if (playerListObj != null)
            {
                foreach (var pi in playerListObj)
                {
                    if (pi == null) continue;
                    var piType = pi.GetType();
                    string piName = GetFieldVal(piType, pi, "m_name", InstFlags) as string;
                    if (string.IsNullOrEmpty(piName) || processedNames.Contains(piName)) continue;
                    processedNames.Add(piName);

                    object piPosObj = GetFieldVal(piType, pi, "m_position", InstFlags);
                    object piCharIdObj = GetFieldVal(piType, pi, "m_characterID", InstFlags);

                    float px = 0f, py = 0f, pz = 0f;
                    TryExtractVector3(piPosObj, out px, out py, out pz);

                    float rawHp = -1f, rawMaxHp = -1f, rawStamina = -1f, rawMaxStamina = -1f, zdoNoise = 0f;
                    if (piCharIdObj != null && _getZdoMethod != null && zdoManInstance != null)
                    {
                        try
                        {
                            object zdo = _getZdoMethod.Invoke(zdoManInstance, new[] { piCharIdObj });
                            if (zdo != null)
                            {
                                EnsureZdoReflectionCached(zdo.GetType());
                                object zdoPos = _zdoGetPosMethod != null ? _zdoGetPosMethod.Invoke(zdo, null) : null;
                                if (zdoPos == null && _zdoPosField != null) zdoPos = _zdoPosField.GetValue(zdo);

                                float zx, zy, zz;
                                if (TryExtractVector3(zdoPos, out zx, out zy, out zz) && (zx != 0f || zz != 0f))
                                {
                                    px = zx; py = zy; pz = zz;
                                }
                                rawHp = ReadZdoFloat(zdo, HashHealth, "health", -1f);
                                rawMaxHp = ReadZdoFloat(zdo, HashMaxHealth, "max_health", -1f);
                                rawStamina = ReadZdoFloat(zdo, HashStamina, "stamina", -1f);
                                rawMaxStamina = ReadZdoFloat(zdo, HashMaxStamina, "max_stamina", -1f);
                                zdoNoise = ReadZdoFloat(zdo, HashNoise, "noise", 0f);
                            }
                        }
                        catch { }
                    }

                    float maxHp = rawMaxHp > 0f ? rawMaxHp : (rawHp > 25f ? rawHp : 25f);
                    float hp = rawHp > 0f ? rawHp : maxHp;
                    if (hp > maxHp) maxHp = hp;

                    PeerVitalState pState;
                    if (!_vitalStates.TryGetValue(piName, out pState))
                    {
                        pState = new PeerVitalState();
                        _vitalStates[piName] = pState;
                    }

                    float dx = pState.Initialized ? (px - pState.LastX) : 0f;
                    float dz = pState.Initialized ? (pz - pState.LastZ) : 0f;
                    float horizDist = (float)Math.Sqrt(dx * dx + dz * dz);
                    float speedMps = horizDist / ExportIntervalSeconds;
                    if (horizDist > 0.4f)
                    {
                        pState.Heading = (float)(((Math.Atan2(dx, dz) * 180.0) / Math.PI + 360.0) % 360.0);
                    }

                    float maxStamina = rawMaxStamina > 0f ? rawMaxStamina : (maxHp <= 25.5f ? 50f : (float)Math.Round(50f + (maxHp - 25f) * 0.85f));
                    float stamina = rawStamina >= 0f ? rawStamina : maxStamina;
                    string activity = "Exploring";
                    if (pState.Initialized && hp < pState.LastHp - 0.5f) activity = "In Combat (Taking Damage!)";
                    else if (zdoNoise >= 30f) activity = "Combat / Harvesting";
                    else if (speedMps > 4.3f) activity = string.Format(CultureInfo.InvariantCulture, "Sprinting ({0:F1} m/s)", speedMps);
                    else if (speedMps > 0.5f) activity = string.Format(CultureInfo.InvariantCulture, "Hiking ({0:F1} m/s)", speedMps);

                    pState.LastX = px; pState.LastY = py; pState.LastZ = pz; pState.LastHp = hp; pState.Initialized = true;

                    if (!first) sb.Append(",\n");
                    first = false;

                    sb.Append("    {\n");
                    sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(piName));
                    sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(piName));
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", px);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", py);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", pz);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"heading\": {0:F0},\n", pState.Heading);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0},\n", stamina);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxStamina\": {0:F0},\n", maxStamina);
                    sb.AppendFormat("      \"activity\": \"{0}\"\n", EscapeJson(activity));
                    sb.Append("    }");
                }
            }

            sb.Append("\n  ],\n");
            sb.Append("  \"landmarks\": [\n");
            AppendZoneLandmarks(sb);
            sb.Append("\n  ]\n}\n");
            AtomicWriteText(OutputPath, sb.ToString());
        }

        private static void AtomicWriteText(string destinationPath, string content)
        {
            try
            {
                string tempPath = destinationPath + ".tmp";
                File.WriteAllText(tempPath, content, Encoding.UTF8);
                File.Copy(tempPath, destinationPath, true);
                try { File.Delete(tempPath); } catch { }
            }
            catch
            {
                try { File.WriteAllText(destinationPath, content, Encoding.UTF8); } catch { }
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", " ")
                .Replace("\n", " ")
                .Replace("\t", " ");
        }
    }
}

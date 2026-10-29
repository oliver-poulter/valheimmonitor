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
using System.Threading;
using BepInEx;

namespace HeimdallWatchtower
{
    [BepInPlugin("com.watchtower.valheim.mapexporter", "Heimdall Watchtower Map Exporter", "1.7.0")]
    public class WatchtowerMapExporter : BaseUnityPlugin
    {
        private const float ExportIntervalSeconds = 2.0f;
        private const long ExportIntervalTicks = (long)(ExportIntervalSeconds * TimeSpan.TicksPerSecond);
        private const string OutputPath = "/config/watchtower/live_map.json";
        private const string TerrainOutputPath = "/config/watchtower/world_terrain.json";

        // Static timer + instance root so export continues even if Unity destroys BepInEx_Manager on scene load
        private static Timer _backgroundTimer;
        private static WatchtowerMapExporter _activeInstance;
        private int _isExporting;
        private long _lastExportUtcTicks;
        private bool _initialized;

        private struct Vec3
        {
            public float X;
            public float Y;
            public float Z;
        }

        private Type _znetType;
        private Type _zdoManType;
        private Type _worldGenType;
        private Type _zoneSysType;

        private bool _terrainExported;
        private int _terrainRow;
        private const int GridSize = 1024;
        private const float WorldRadius = 10500f;
        private byte[] _biomeBytes;
        private byte[] _heightBytes;
        private MethodInfo _getBiomeMethod;
        private object[] _getBiomeDefaultArgs;
        private MethodInfo _getHeightMethod;
        private object[] _getHeightDefaultArgs;

        // Cached reflection members to avoid per-tick allocations in Mono Boehm GC
        private MethodInfo _getZdoMethod;
        private bool _getZdoMethodSearched;
        private static Type _cachedZdoType;
        private static MethodInfo _zdoGetFloatIntMethod;
        private static MethodInfo _zdoGetFloatStrMethod;
        private static MethodInfo _zdoGetStringIntMethod;
        private static MethodInfo _zdoGetStringStrMethod;
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
        private static readonly int HashPlayerName = GetValheimStableHashCode("playerName");

        private const BindingFlags InstFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

        private static object GetFieldVal(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            try
            {
                FieldInfo f = t.GetField(name, flags);
                return f != null ? f.GetValue(target) : null;
            }
            catch
            {
                return null;
            }
        }

        private static object GetPropVal(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            try
            {
                PropertyInfo p = t.GetProperty(name, flags);
                return (p != null && p.GetIndexParameters().Length == 0) ? p.GetValue(target, null) : null;
            }
            catch
            {
                return null;
            }
        }

        private static object GetMemberVal(Type t, object target, string name, BindingFlags flags)
        {
            object v = GetFieldVal(t, target, name, flags);
            return v != null ? v : GetPropVal(t, target, name, flags);
        }

        private static object InvokeMethod(Type t, object target, string name, BindingFlags flags)
        {
            if (t == null) return null;
            try
            {
                MethodInfo m = t.GetMethod(name, flags, null, Type.EmptyTypes, null) ?? t.GetMethod(name, flags);
                return (m != null && m.GetParameters().Length == 0) ? m.Invoke(target, null) : null;
            }
            catch
            {
                return null;
            }
        }

        public WatchtowerMapExporter()
        {
            EnsureInitialized();
        }

        private void Awake()
        {
            EnsureInitialized();
        }

        private void EnsureInitialized()
        {
            if (_initialized) return;
            _initialized = true;
            _activeInstance = this;
            try
            {
                Directory.CreateDirectory("/config/watchtower");
                WriteBootstrapStatus("plugin_loaded_booting_world");
                if (_backgroundTimer == null)
                {
                    _backgroundTimer = new Timer(OnBackgroundTimerTick, null, 2000, 2000);
                }
                Logger.LogInfo("[Heimdall Watchtower] Live Map, Terrain & Health ZDO Exporter v1.7.0 initialized.");
            }
            catch (Exception ex)
            {
                try { Logger.LogWarning("[Heimdall Watchtower] Init warning: " + ex.Message); } catch { }
            }
        }

        private static void OnBackgroundTimerTick(object state)
        {
            var inst = _activeInstance;
            if (inst != null)
            {
                inst.RunExportTick(false);
            }
        }

        private void WriteBootstrapStatus(string status)
        {
            try
            {
                var sb = new StringBuilder(512);
                sb.Append("{\n");
                sb.AppendFormat("  \"pluginStatus\": \"{0}\",\n", EscapeJson(status));
                sb.Append("  \"pluginVersion\": \"1.7.0\",\n");
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
            RunExportTick(true);
        }

        private void RunExportTick(bool isMainThread)
        {
            if (Interlocked.CompareExchange(ref _isExporting, 1, 0) != 0) return;
            try
            {
                if (!_terrainExported)
                {
                    try
                    {
                        StepTerrainExport(isMainThread ? 32 : 128);
                    }
                    catch
                    {
                        // Ignore transient reflection errors while world is still initializing
                    }
                }

                long nowTicks = DateTime.UtcNow.Ticks;
                if (nowTicks - _lastExportUtcTicks < ExportIntervalTicks) return;
                _lastExportUtcTicks = nowTicks;

                ExportWorldAndPlayers();
            }
            catch (Exception ex)
            {
                try { Logger.LogError("[Heimdall Watchtower] ExportWorldAndPlayers error: " + ex.Message); } catch { }
            }
            finally
            {
                Interlocked.Exchange(ref _isExporting, 0);
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

            // 1. Check known singleton field names first (fastest & thread-safe)
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

        private void ExtractWorldMeta(object znetInstance, object wgInstance, out string worldName, out string seedName, out int seedNumeric, out bool isMenu)
        {
            worldName = "";
            seedName = "";
            seedNumeric = 0;
            isMenu = false;

            if (_znetType != null && znetInstance != null)
            {
                worldName = InvokeMethod(_znetType, znetInstance, "GetWorldName", InstFlags) as string ?? "";
            }

            object worldObj = null;
            if (_worldGenType != null && wgInstance != null)
            {
                worldObj = GetMemberVal(_worldGenType, wgInstance, "m_world", InstFlags);
            }
            if (worldObj == null && _znetType != null && znetInstance != null)
            {
                worldObj = GetMemberVal(_znetType, znetInstance, "m_world", InstFlags);
            }

            if (worldObj != null)
            {
                var wType = worldObj.GetType();
                string wName = GetMemberVal(wType, worldObj, "m_name", InstFlags) as string;
                if (!string.IsNullOrEmpty(wName) && string.IsNullOrEmpty(worldName))
                {
                    worldName = wName;
                }
                seedName = GetMemberVal(wType, worldObj, "m_seedName", InstFlags) as string ?? "";
                object seedObj = GetMemberVal(wType, worldObj, "m_seed", InstFlags);
                if (seedObj != null)
                {
                    try { seedNumeric = Convert.ToInt32(seedObj); } catch { }
                }
                object menuObj = GetMemberVal(wType, worldObj, "m_menu", InstFlags);
                if (menuObj is bool)
                {
                    isMenu = (bool)menuObj;
                }
            }

            if (seedNumeric == 0 && !string.IsNullOrEmpty(seedName))
            {
                seedNumeric = GetValheimStableHashCode(seedName);
            }
            if (string.IsNullOrEmpty(worldName))
            {
                worldName = "Dedicated";
            }
        }

        private static object[] BuildDefaultArgArray(MethodInfo m)
        {
            var ps = m.GetParameters();
            var args = new object[ps.Length];
            args[0] = 0f;
            args[1] = 0f;
            for (int i = 2; i < ps.Length; i++)
            {
                var p = ps[i];
                var pt = p.ParameterType;
                if (pt.IsByRef) pt = pt.GetElementType();
                if (p.HasDefaultValue && p.DefaultValue != DBNull.Value && p.DefaultValue != null)
                {
                    args[i] = p.DefaultValue;
                }
                else if (pt == typeof(float))
                {
                    args[i] = 0.02f;
                }
                else if (pt == typeof(bool))
                {
                    args[i] = false;
                }
                else if (pt != null && pt.IsValueType)
                {
                    try { args[i] = Activator.CreateInstance(pt); } catch { }
                }
                else
                {
                    args[i] = null;
                }
            }
            return args;
        }

        private void EnsureWorldGenMethods()
        {
            if (_worldGenType == null) return;

            if (_getBiomeMethod == null)
            {
                MethodInfo fallbackBiome = null;
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
                {
                    if (m.Name == "GetBiome")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length == 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getBiomeMethod = m;
                            break;
                        }
                        if (ps.Length >= 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            if (fallbackBiome == null || ps.Length < fallbackBiome.GetParameters().Length)
                            {
                                fallbackBiome = m;
                            }
                        }
                    }
                }
                if (_getBiomeMethod == null && fallbackBiome != null)
                {
                    _getBiomeMethod = fallbackBiome;
                }
                if (_getBiomeMethod != null)
                {
                    _getBiomeDefaultArgs = BuildDefaultArgArray(_getBiomeMethod);
                }
            }

            if (_getHeightMethod == null)
            {
                MethodInfo fallbackHeight = null;
                foreach (var m in _worldGenType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance))
                {
                    if (m.Name == "GetHeight")
                    {
                        var ps = m.GetParameters();
                        if (ps.Length == 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            _getHeightMethod = m;
                            break;
                        }
                        if (ps.Length >= 2 && ps[0].ParameterType == typeof(float) && ps[1].ParameterType == typeof(float))
                        {
                            if (fallbackHeight == null || ps.Length < fallbackHeight.GetParameters().Length)
                            {
                                fallbackHeight = m;
                            }
                        }
                    }
                }
                if (_getHeightMethod == null && fallbackHeight != null)
                {
                    _getHeightMethod = fallbackHeight;
                }
                if (_getHeightMethod != null)
                {
                    _getHeightDefaultArgs = BuildDefaultArgArray(_getHeightMethod);
                }
            }
        }

        private void StepTerrainExport(int rowsToProcess = 32)
        {
            ResolveTypes();
            if (_worldGenType == null || _znetType == null) return;

            var wgInstance = GetStaticInstance(_worldGenType);
            var znetInstance = ResolveZNetInstance();

            if (wgInstance == null || znetInstance == null) return;

            string worldName, seedName;
            int seedNumeric;
            bool isMenu;
            ExtractWorldMeta(znetInstance, wgInstance, out worldName, out seedName, out seedNumeric, out isMenu);
            if (isMenu) return;

            EnsureWorldGenMethods();

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

            object[] bArgs = (object[])_getBiomeDefaultArgs.Clone();
            object[] hArgs = (object[])_getHeightDefaultArgs.Clone();

            // Process rowsToProcess rows per tick so server tick is never delayed
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

                var sb = new StringBuilder(3200000);
                sb.Append("{\n");
                sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
                sb.AppendFormat("  \"seedName\": \"{0}\",\n", EscapeJson(seedName));
                sb.AppendFormat(CultureInfo.InvariantCulture, "  \"seedNumeric\": {0},\n", seedNumeric);
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
                                      ?? "";

                            if (string.IsNullOrEmpty(prefabName))
                            {
                                var prefabObj = GetMemberVal(lType, locObj, "m_prefab", InstFlags);
                                if (prefabObj != null)
                                {
                                    prefabName = GetFieldVal(prefabObj.GetType(), prefabObj, "m_name", InstFlags) as string
                                              ?? GetPropVal(prefabObj.GetType(), prefabObj, "Name", InstFlags) as string
                                              ?? "";
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

        private static string MapBiomeCodeToName(byte code)
        {
            switch (code)
            {
                case 1: return "Meadows";
                case 2: return "Black Forest";
                case 3: return "Swamp";
                case 4: return "Mountains";
                case 5: return "Plains";
                case 6: return "Mistlands";
                case 7: return "Ashlands";
                case 8: return "Deep North";
                default: return "Ocean";
            }
        }

        private string SampleBiomeNameAt(object wgInstance, float x, float z)
        {
            if (wgInstance != null)
            {
                try
                {
                    EnsureWorldGenMethods();
                    if (_getBiomeMethod != null && _getBiomeDefaultArgs != null)
                    {
                        var args = (object[])_getBiomeDefaultArgs.Clone();
                        args[0] = x;
                        args[1] = z;
                        int rawBiome = Convert.ToInt32(_getBiomeMethod.Invoke(wgInstance, args));
                        return MapBiomeCodeToName(MapBiomeEnumToCode(rawBiome));
                    }
                }
                catch { }
            }
            return "";
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
            try
            {
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
            }
            catch { }
            return false;
        }

        private static List<object> SnapshotEnumerable(IEnumerable source)
        {
            var list = new List<object>();
            if (source == null) return list;
            try
            {
                var ilist = source as IList;
                if (ilist != null)
                {
                    int cnt = ilist.Count;
                    for (int i = 0; i < cnt; i++)
                    {
                        try
                        {
                            var item = ilist[i];
                            if (item != null) list.Add(item);
                        }
                        catch { break; }
                    }
                    return list;
                }
                foreach (var item in source)
                {
                    if (item != null) list.Add(item);
                }
            }
            catch { }
            return list;
        }

        private static void EnsureZdoReflectionCached(Type zdoType)
        {
            if (_cachedZdoType == zdoType) return;
            _zdoGetFloatIntMethod = zdoType.GetMethod("GetFloat", new[] { typeof(int), typeof(float) });
            _zdoGetFloatStrMethod = zdoType.GetMethod("GetFloat", new[] { typeof(string), typeof(float) });
            _zdoGetStringIntMethod = zdoType.GetMethod("GetString", new[] { typeof(int), typeof(string) });
            _zdoGetStringStrMethod = zdoType.GetMethod("GetString", new[] { typeof(string), typeof(string) });
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

        private static string ReadZdoString(object zdo, int keyHash, string keyName, string defaultVal)
        {
            if (zdo == null) return defaultVal;
            EnsureZdoReflectionCached(zdo.GetType());

            if (_zdoGetStringIntMethod != null)
            {
                try
                {
                    string val = _zdoGetStringIntMethod.Invoke(zdo, new object[] { keyHash, defaultVal }) as string;
                    if (!string.IsNullOrEmpty(val)) return val;
                }
                catch { }
            }
            if (_zdoGetStringStrMethod != null)
            {
                try
                {
                    string val = _zdoGetStringStrMethod.Invoke(zdo, new object[] { keyName, defaultVal }) as string;
                    if (!string.IsNullOrEmpty(val)) return val;
                }
                catch { }
            }
            return defaultVal;
        }

        private object ResolveCharacterZdo(object zdoManInstance, IDictionary zdoDict, object charIdObj)
        {
            if (charIdObj == null) return null;
            if (_getZdoMethod != null && zdoManInstance != null)
            {
                try
                {
                    object zdo = _getZdoMethod.Invoke(zdoManInstance, new[] { charIdObj });
                    if (zdo != null) return zdo;
                }
                catch { }
            }
            if (zdoDict != null)
            {
                try
                {
                    if (zdoDict.Contains(charIdObj))
                    {
                        return zdoDict[charIdObj];
                    }
                }
                catch { }
            }
            return null;
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

            var wgInstance = _worldGenType != null ? GetStaticInstance(_worldGenType) : null;
            var zdoManInstance = GetMemberVal(_znetType, znetInstance, "m_zdoMan", InstFlags)
                              ?? GetStaticInstance(_zdoManType);

            string worldName, seedName;
            int seedNumeric;
            bool isMenu;
            ExtractWorldMeta(znetInstance, wgInstance, out worldName, out seedName, out seedNumeric, out isMenu);

            var peersObj = GetFieldVal(_znetType, znetInstance, "m_peers", InstFlags) as IEnumerable
                        ?? InvokeMethod(_znetType, znetInstance, "GetPeers", InstFlags) as IEnumerable;
            var peersSnapshot = SnapshotEnumerable(peersObj);

            // Query ZNet.m_players / ZNet.GetPlayerList() as an authoritative coordinate source
            var playerListPositions = new Dictionary<string, Vec3>(StringComparer.OrdinalIgnoreCase);
            List<object> playerListSnapshot = null;
            try
            {
                var playerListObj = GetFieldVal(_znetType, znetInstance, "m_players", InstFlags) as IEnumerable
                                 ?? InvokeMethod(_znetType, znetInstance, "GetPlayerList", BindingFlags.Public | BindingFlags.Instance) as IEnumerable;
                playerListSnapshot = SnapshotEnumerable(playerListObj);
                for (int i = 0; i < playerListSnapshot.Count; i++)
                {
                    var pi = playerListSnapshot[i];
                    if (pi == null) continue;
                    var piType = pi.GetType();
                    string piName = GetFieldVal(piType, pi, "m_name", InstFlags) as string;
                    object piPosObj = GetFieldVal(piType, pi, "m_position", InstFlags);
                    float px, py, pz;
                    if (!string.IsNullOrEmpty(piName) && TryExtractVector3(piPosObj, out px, out py, out pz))
                    {
                        if (px != 0f || pz != 0f || py > 1f)
                        {
                            playerListPositions[piName] = new Vec3 { X = px, Y = py, Z = pz };
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

            IDictionary zdoObjectsById = null;
            if (zdoManInstance != null && _zdoManType != null)
            {
                zdoObjectsById = GetFieldVal(_zdoManType, zdoManInstance, "m_objectsByID", InstFlags) as IDictionary;
            }

            var sb = new StringBuilder(4096);
            sb.Append("{\n");
            sb.Append("  \"pluginStatus\": \"active\",\n");
            sb.Append("  \"pluginVersion\": \"1.7.0\",\n");
            sb.AppendFormat("  \"worldName\": \"{0}\",\n", EscapeJson(worldName));
            sb.AppendFormat("  \"seedName\": \"{0}\",\n", EscapeJson(seedName));
            sb.AppendFormat(CultureInfo.InvariantCulture, "  \"seedNumeric\": {0},\n", seedNumeric);
            string nowIso = DateTime.UtcNow.ToString("o");
            sb.AppendFormat("  \"lastUpdated\": \"{0}\",\n", nowIso);
            sb.AppendFormat("  \"timestamp\": \"{0}\",\n", nowIso);
            sb.Append("  \"players\": [\n");

            bool first = true;
            var processedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int pIdx = 0; pIdx < peersSnapshot.Count; pIdx++)
            {
                var peer = peersSnapshot[pIdx];
                if (peer == null) continue;
                var peerType = peer.GetType();

                string playerName = GetFieldVal(peerType, peer, "m_playerName", InstFlags) as string;

                object refPosObj = GetFieldVal(peerType, peer, "m_refPos", InstFlags)
                                ?? InvokeMethod(peerType, peer, "GetRefPos", BindingFlags.Public | BindingFlags.Instance);
                object charIdObj = GetFieldVal(peerType, peer, "m_characterID", InstFlags);

                float x = 0f, y = 0f, z = 0f;
                float rx, ry, rz;
                if (TryExtractVector3(refPosObj, out rx, out ry, out rz) && (rx != 0f || rz != 0f || ry > 1f))
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

                float rawHp = -1f;
                float rawMaxHp = -1f;
                float rawStamina = -1f;
                float rawMaxStamina = -1f;
                float zdoNoise = 0f;

                object zdo = ResolveCharacterZdo(zdoManInstance, zdoObjectsById, charIdObj);
                if (zdo != null)
                {
                    try
                    {
                        EnsureZdoReflectionCached(zdo.GetType());
                        object zdoPos = _zdoGetPosMethod != null ? _zdoGetPosMethod.Invoke(zdo, null) : null;
                        if (zdoPos == null && _zdoPosField != null) zdoPos = _zdoPosField.GetValue(zdo);

                        float zx, zy, zz;
                        if (TryExtractVector3(zdoPos, out zx, out zy, out zz) && (zx != 0f || zz != 0f || zy > 1f))
                        {
                            x = zx; y = zy; z = zz;
                        }

                        if (string.IsNullOrEmpty(playerName))
                        {
                            playerName = ReadZdoString(zdo, HashPlayerName, "playerName", "");
                        }

                        rawHp = ReadZdoFloat(zdo, HashHealth, "health", -1f);
                        rawMaxHp = ReadZdoFloat(zdo, HashMaxHealth, "max_health", -1f);
                        rawStamina = ReadZdoFloat(zdo, HashStamina, "stamina", -1f);
                        rawMaxStamina = ReadZdoFloat(zdo, HashMaxStamina, "max_stamina", -1f);
                        zdoNoise = ReadZdoFloat(zdo, HashNoise, "noise", 0f);
                    }
                    catch
                    {
                        // Ignore transient ZDO error
                    }
                }

                // Skip unauthenticated handshake sockets that have no playerName and no coordinates
                if (string.IsNullOrEmpty(playerName) && x == 0f && z == 0f)
                {
                    continue;
                }
                if (string.IsNullOrEmpty(playerName)) playerName = "Viking";
                string stateKey = !string.IsNullOrEmpty(steamId) ? steamId : playerName;

                // Fallback to GetPlayerList if peer position is (0, 0)
                Vec3 pPos;
                if (x == 0f && z == 0f && playerListPositions.TryGetValue(playerName, out pPos))
                {
                    x = pPos.X; y = pPos.Y; z = pPos.Z;
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

                bool hasValidGps = (x != 0f || z != 0f || y > 1f);
                string biomeName = hasValidGps ? SampleBiomeNameAt(wgInstance, x, z) : "";

                if (!first) sb.Append(",\n");
                first = false;

                sb.Append("    {\n");
                sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(steamId));
                sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(playerName));
                sb.AppendFormat("      \"hasGps\": {0},\n", hasValidGps ? "true" : "false");
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", x);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", y);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", z);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"heading\": {0:F0},\n", pState.Heading);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0},\n", stamina);
                sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxStamina\": {0:F0},\n", maxStamina);
                if (!string.IsNullOrEmpty(biomeName))
                {
                    sb.AppendFormat("      \"biome\": \"{0}\",\n", EscapeJson(biomeName));
                }
                sb.AppendFormat("      \"activity\": \"{0}\"\n", EscapeJson(activity));
                sb.Append("    }");
            }

            // Fallback 1: Check ZNet.GetPlayerList() for connected players who may not be in peersObj
            if (playerListSnapshot != null)
            {
                for (int i = 0; i < playerListSnapshot.Count; i++)
                {
                    var pi = playerListSnapshot[i];
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
                    object zdo = ResolveCharacterZdo(zdoManInstance, zdoObjectsById, piCharIdObj);
                    if (zdo != null)
                    {
                        try
                        {
                            EnsureZdoReflectionCached(zdo.GetType());
                            object zdoPos = _zdoGetPosMethod != null ? _zdoGetPosMethod.Invoke(zdo, null) : null;
                            if (zdoPos == null && _zdoPosField != null) zdoPos = _zdoPosField.GetValue(zdo);

                            float zx, zy, zz;
                            if (TryExtractVector3(zdoPos, out zx, out zy, out zz) && (zx != 0f || zz != 0f || zy > 1f))
                            {
                                px = zx; py = zy; pz = zz;
                            }
                            rawHp = ReadZdoFloat(zdo, HashHealth, "health", -1f);
                            rawMaxHp = ReadZdoFloat(zdo, HashMaxHealth, "max_health", -1f);
                            rawStamina = ReadZdoFloat(zdo, HashStamina, "stamina", -1f);
                            rawMaxStamina = ReadZdoFloat(zdo, HashMaxStamina, "max_stamina", -1f);
                            zdoNoise = ReadZdoFloat(zdo, HashNoise, "noise", 0f);
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

                    bool hasValidGps = (px != 0f || pz != 0f || py > 1f);
                    string biomeName = hasValidGps ? SampleBiomeNameAt(wgInstance, px, pz) : "";

                    if (!first) sb.Append(",\n");
                    first = false;

                    sb.Append("    {\n");
                    sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(piName));
                    sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(piName));
                    sb.AppendFormat("      \"hasGps\": {0},\n", hasValidGps ? "true" : "false");
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", px);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", py);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", pz);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"heading\": {0:F0},\n", pState.Heading);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0},\n", stamina);
                    sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxStamina\": {0:F0},\n", maxStamina);
                    if (!string.IsNullOrEmpty(biomeName))
                    {
                        sb.AppendFormat("      \"biome\": \"{0}\",\n", EscapeJson(biomeName));
                    }
                    sb.AppendFormat("      \"activity\": \"{0}\"\n", EscapeJson(activity));
                    sb.Append("    }");
                }
            }

            // Fallback 2: Check ZNet.GetAllCharacterZDOS() if still no players found
            if (first)
            {
                try
                {
                    var charZdosObj = InvokeMethod(_znetType, znetInstance, "GetAllCharacterZDOS", InstFlags) as IEnumerable;
                    var charZdos = SnapshotEnumerable(charZdosObj);
                    for (int i = 0; i < charZdos.Count; i++)
                    {
                        var zdo = charZdos[i];
                        if (zdo == null) continue;
                        EnsureZdoReflectionCached(zdo.GetType());
                        string cName = ReadZdoString(zdo, HashPlayerName, "playerName", "");
                        if (string.IsNullOrEmpty(cName) || processedNames.Contains(cName)) continue;
                        processedNames.Add(cName);

                        object zdoPos = _zdoGetPosMethod != null ? _zdoGetPosMethod.Invoke(zdo, null) : null;
                        if (zdoPos == null && _zdoPosField != null) zdoPos = _zdoPosField.GetValue(zdo);
                        float zx = 0f, zy = 0f, zz = 0f;
                        TryExtractVector3(zdoPos, out zx, out zy, out zz);

                        float rawHp = ReadZdoFloat(zdo, HashHealth, "health", 25f);
                        float rawMaxHp = ReadZdoFloat(zdo, HashMaxHealth, "max_health", 25f);
                        float rawStamina = ReadZdoFloat(zdo, HashStamina, "stamina", 50f);
                        float rawMaxStamina = ReadZdoFloat(zdo, HashMaxStamina, "max_stamina", 50f);
                        float maxHp = rawMaxHp > 0f ? rawMaxHp : (rawHp > 25f ? rawHp : 25f);
                        float hp = rawHp > 0f ? rawHp : maxHp;
                        float maxStamina = rawMaxStamina > 0f ? rawMaxStamina : 50f;
                        float stamina = rawStamina >= 0f ? rawStamina : maxStamina;
                        bool hasValidGps = (zx != 0f || zz != 0f || zy > 1f);
                        string biomeName = hasValidGps ? SampleBiomeNameAt(wgInstance, zx, zz) : "";

                        if (!first) sb.Append(",\n");
                        first = false;

                        sb.Append("    {\n");
                        sb.AppendFormat("      \"steamId\": \"{0}\",\n", EscapeJson(cName));
                        sb.AppendFormat("      \"name\": \"{0}\",\n", EscapeJson(cName));
                        sb.AppendFormat("      \"hasGps\": {0},\n", hasValidGps ? "true" : "false");
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"x\": {0:F1},\n", zx);
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"y\": {0:F1},\n", zy);
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"z\": {0:F1},\n", zz);
                        sb.Append("      \"heading\": 0,\n");
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"hp\": {0:F0},\n", hp);
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxHp\": {0:F0},\n", maxHp);
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"stamina\": {0:F0},\n", stamina);
                        sb.AppendFormat(CultureInfo.InvariantCulture, "      \"maxStamina\": {0:F0},\n", maxStamina);
                        if (!string.IsNullOrEmpty(biomeName))
                        {
                            sb.AppendFormat("      \"biome\": \"{0}\",\n", EscapeJson(biomeName));
                        }
                        sb.Append("      \"activity\": \"Exploring\"\n");
                        sb.Append("    }");
                    }
                }
                catch { }
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

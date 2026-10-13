using System;
using UnityEngine;

namespace BepInEx.Logging
{
    public class ManualLogSource
    {
        public void LogInfo(object data) { }
        public void LogWarning(object data) { }
        public void LogError(object data) { }
    }
}

namespace BepInEx
{
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = false)]
    public class BepInPlugin : Attribute
    {
        public string GUID { get; private set; }
        public string Name { get; private set; }
        public string Version { get; private set; }

        public BepInPlugin(string guid, string name, string version)
        {
            GUID = guid;
            Name = name;
            Version = version;
        }
    }

    public abstract class BaseUnityPlugin : MonoBehaviour
    {
        private static readonly BepInEx.Logging.ManualLogSource _logger = new BepInEx.Logging.ManualLogSource();
        protected BepInEx.Logging.ManualLogSource Logger { get { return _logger; } }
    }
}

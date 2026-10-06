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
        public string GUID { get; }
        public string Name { get; }
        public string Version { get; }

        public BepInPlugin(string guid, string name, string version)
        {
            GUID = guid;
            Name = name;
            Version = version;
        }
    }

    public abstract class BaseUnityPlugin : MonoBehaviour
    {
        protected BepInEx.Logging.ManualLogSource Logger { get; } = new BepInEx.Logging.ManualLogSource();
    }
}

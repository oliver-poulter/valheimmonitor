using System;

namespace UnityEngine
{
    public class Object
    {
        public static Object FindObjectOfType(Type type) { return null; }
        public static Object[] FindObjectsOfType(Type type) { return new Object[0]; }
    }
    public class Component : Object { }
    public class Behaviour : Component { }
    public class MonoBehaviour : Behaviour { }

    public struct Vector3
    {
        public float x;
        public float y;
        public float z;
    }

    public static class Time
    {
        public static float deltaTime { get { return 0.02f; } }
    }
}

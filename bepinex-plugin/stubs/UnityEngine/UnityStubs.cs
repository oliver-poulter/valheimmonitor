using System;

namespace UnityEngine
{
    public class Object { }
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
        public static float deltaTime => 0.02f;
    }
}

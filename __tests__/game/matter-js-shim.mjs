// Node's ESM named-export detection does not expose Matter's CommonJS members.
// Re-export the real implementation explicitly so PlayScene/PhysicsWorld tests
// exercise Matter rather than a hand-written physics double.
import matter from "matter-js";

export const {
  Engine,
  World,
  Bodies,
  Body,
  Composite,
  Constraint,
  Events,
} = matter;

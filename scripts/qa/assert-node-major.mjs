const REQUIRED_NODE_MAJOR = 22;
const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);

if (major !== REQUIRED_NODE_MAJOR) {
  console.error(
    `Build requires Node ${REQUIRED_NODE_MAJOR}.x; received Node ${process.versions.node}.`,
  );
  process.exitCode = 1;
}

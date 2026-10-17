import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BoxSandbox } from "../src/box-sandbox";

function loadEnv(name: string): string {
  try {
    const raw = readFileSync(resolve(import.meta.dirname, "../.env.local"), "utf8");
    const line = raw.split("\n").find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  } catch {
    // fall through to process.env
  }
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  throw new Error(`missing ${name}`);
}

const apiKey = loadEnv("UPSTASH_BOX_API_KEY");

async function main() {
  const name = `buildx-country-test-${Date.now()}`;
  const sandbox = new BoxSandbox({
    name,
    apiKey,
    runtime: "node",
    size: "small",
    initCommand: "",
  });

  try {
    console.log("--- start() ---");
    await sandbox.start();
    console.log("started; id =", sandbox.id);

    console.log("\n--- exec: hello ---");
    const chunks: { stream: string; data: string }[] = [];
    for await (const c of sandbox.exec("echo hello from box")) {
      chunks.push(c);
    }
    console.log("chunks:", JSON.stringify(chunks));
    if (!chunks.some((c) => c.stream === "stdout" && c.data.includes("hello from box"))) {
      throw new Error("exec stdout missing expected output");
    }

    console.log("\n--- writeFile/readFile ---");
    await sandbox.writeFile("notes.txt", "line one\nline two\nline three\n");
    const full = await sandbox.readFile("notes.txt");
    console.log("full:", JSON.stringify(full));
    const range = await sandbox.readFile("notes.txt", { offset: 1, limit: 1 });
    console.log("range (offset=1,limit=1):", JSON.stringify(range));
    if (full.includes("line two") === false) throw new Error("readFile full failed");

    console.log("\n--- listDir/readInfo ---");
    const entries = await sandbox.listDir(".");
    console.log("entries:", entries.map((e) => `${e.name} (${e.type})`));
    const info = await sandbox.readInfo("notes.txt");
    console.log("readInfo:", JSON.stringify(info));

    console.log("\n--- startBackground + previewUrl ---");
    await sandbox.startBackground("node -e \"require('http').createServer((q,r)=>{r.end('hello')}).listen(8000)\"");
    const url = await sandbox.previewUrl(8000);
    console.log("preview URL:", url);

    console.log("\n--- checkpoint ---");
    const snapId = await sandbox.checkpoint("before-test");
    console.log("snapshot id:", snapId);

    console.log("\n--- exec (mutate) then restore ---");
    await sandbox.writeFile("notes.txt", "MUTATED");
    await sandbox.restore(snapId);
    const restored = await sandbox.readFile("notes.txt");
    console.log("restored notes:", JSON.stringify(restored));
    if (restored !== "line one\nline two\nline three\n") {
      throw new Error("restore did not bring back original notes");
    }

    console.log("\n--- suspend ---");
    await sandbox.suspend();
    console.log("suspended (best-effort)");

    console.log("\nALL INTEGRATION CHECKS PASSED");
  } finally {
    console.log("\n--- destroy ---");
    await sandbox.destroy();
    console.log("destroyed");
  }
}

main().catch((e) => {
  console.error("integration test failed:", e);
  process.exit(1);
});
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const artifacts = [
  {
    output: "artifacts/codex-cloud/basic-spreadsheet.xlsx",
    encoded: "artifacts/codex-cloud/basic-spreadsheet.xlsx.base64",
    sha256: "78cf357485171543c31a39ded75bf60adfc943fcfdd873b9ff926e04b1be59f0",
  },
  {
    output: "artifacts/codex-cloud/basic-spreadsheet.png",
    encoded: "artifacts/codex-cloud/basic-spreadsheet.png.base64",
    sha256: "dfc9c09425567ac4ac746d6f03d051e114a328634cda4ddadd2fed246541cd2a",
  },
];

for (const artifact of artifacts) {
  const encoded = await readFile(artifact.encoded, "utf8");
  const bytes = Buffer.from(encoded.replace(/\s/g, ""), "base64");
  const actualHash = createHash("sha256").update(bytes).digest("hex");

  if (actualHash !== artifact.sha256) {
    throw new Error(`Integrity check failed for ${artifact.output}`);
  }

  await writeFile(artifact.output, bytes);
  console.log(`Restored ${artifact.output}`);
}

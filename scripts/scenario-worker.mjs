// Disposable native engine process. Receives only service-read bytes; no file paths or saves.
import { createWorkbook } from '@mog-sdk/sdk';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { bytes, request } = JSON.parse(input);
const cases = [];
try {
  // A fresh engine per case prevents hidden scenario-to-scenario state.
  for (const value of request.values) {
    const workbook = await createWorkbook(Buffer.from(bytes, 'base64'));
    try {
      const sheet = await workbook.getSheet(request.sheet);
      await sheet.setCell(request.input, value);
      await sheet.calculate(true);
      const outputs = {};
      for (const address of request.outputs) {
        const result = await sheet.getValue(address);
        if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('Non-numeric scenario result');
        outputs[address] = result;
      }
      cases.push({ input: value, outputs });
    } finally { await workbook.dispose(); }
  }
  process.stdout.write(JSON.stringify({ cases }));
} catch { process.exitCode = 1; }

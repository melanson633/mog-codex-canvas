// Disposable native engine process. Receives only service-read bytes; no paths or saves.
import { createWorkbook } from '@mog-sdk/sdk';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { bytes, request } = JSON.parse(input);
const workbookBytes = Buffer.from(bytes, 'base64');
const finite = value => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Non-finite calculation'); return value; };
async function evaluate(inputs, outputs) {
 const workbook = await createWorkbook(workbookBytes);
 try {
  const sheet = await workbook.getSheet(request.sheet);
  for (const [address,value] of Object.entries(inputs)) await sheet.setCell(address,value);
  await sheet.calculate(true);
  const result = {};
  for (const address of outputs) result[address] = finite(await sheet.getValue(address));
  return result;
 } finally { await workbook.dispose(); }
}
try {
 let result;
 if (request.kind === 'cases') {
  const cases=[];
  for(const inputs of request.cases) cases.push({inputs,output:(await evaluate(inputs,[request.output]))[request.output]});
  result={cases};
 } else if (request.kind === 'goal') {
  const cases=[];
  async function at(input) { const value=(await evaluate({[request.input]:input},[request.output]))[request.output]; const point={input,value,residual:finite(value-request.target)};cases.push(point);return point; }
  let lower=await at(request.lower),upper=await at(request.upper),best=Math.abs(lower.residual)<=Math.abs(upper.residual)?lower:upper,iterations=0;
  if(Math.abs(best.residual)>request.tolerance && Math.sign(lower.residual)===Math.sign(upper.residual)) { process.stdout.write(JSON.stringify({error:'The target is not bracketed by the endpoint outputs.'})); process.exit(0); }
  while(Math.abs(best.residual)>request.tolerance && iterations<40) {
   const mid=finite(lower.input/2+upper.input/2);
   if(mid===lower.input || mid===upper.input) break;
   const point=await at(mid); iterations++;
   if(Math.abs(point.residual)<Math.abs(best.residual)) best=point;
   if(Math.sign(point.residual)===Math.sign(lower.residual)) lower=point; else upper=point;
  }
  result={status:Math.abs(best.residual)<=request.tolerance?'converged':'not-converged',solution:best.input,value:best.value,residual:best.residual,iterations,cases};
 } else {
  const cases=[];
  for(const value of request.values) cases.push({input:value,outputs:await evaluate({[request.input]:value},request.outputs)});
  result={cases};
 }
 process.stdout.write(JSON.stringify(result));
} catch { process.exitCode=1; }

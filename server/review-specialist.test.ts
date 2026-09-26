import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReviewIntent, reviewSpecialistCapability } from './review-specialist.ts';
const actions=['discuss','classify','score','explain','reconcile','scenario','audit'];
const response=()=>({model:'jev-1.13.0',answers:{intent:{type:'choice',choice:'reconcile',confidence:0.9,probabilities:Object.fromEntries(actions.map(a=>[a,a==='reconcile'?1:0]))}},usage:{input_tokens:100,output_tokens:20}});
test('specialist sends only supplied message and returns validated routing evidence',async(t)=>{
 const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='synthetic-key'; t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
 assert.deepEqual(reviewSpecialistCapability(),{configured:true,model:'jev-1.13.0'});
 t.mock.method(globalThis,'fetch',async(url: string | URL | Request, options?: RequestInit)=>{assert.equal(url,'https://api.typesafe.ai/v1/systemone');const body=JSON.parse(String(options?.body));assert.deepEqual(body.state,{message:'Tie these totals out'});assert.equal(body.model,'jev-1.13.0');assert.deepEqual(Object.keys(body.questions.intent.criteria),actions);return Response.json(response());});
 const result=await classifyReviewIntent('Tie these totals out');assert.equal(result.action,'reconcile');assert.equal(result.confidence,0.9);assert.equal(result.usage?.input_tokens,100);assert.ok(result.elapsedMs>=0);
});
test('specialist rejects invalid input, unavailable credentials, provider errors and malformed answers',async(t)=>{
 const old=process.env.TYPESAFE_API_KEY; t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
 delete process.env.TYPESAFE_API_KEY;assert.equal(reviewSpecialistCapability().configured,false);await assert.rejects(classifyReviewIntent('Help'),/not configured/);
 process.env.TYPESAFE_API_KEY='synthetic-key';await assert.rejects(classifyReviewIntent(' '),/1 to 4,000/);await assert.rejects(classifyReviewIntent('x'.repeat(4001)),/1 to 4,000/);
 const mock=t.mock.method(globalThis,'fetch',async()=>new Response('secret provider body',{status:429}));await assert.rejects(classifyReviewIntent('Help'),/rate limit/);
 for(const change of [(r:any)=>r.answers.intent.choice='delete',(r:any)=>r.answers.intent.probabilities.audit=-1,(r:any)=>r.answers.intent.probabilities.extra=0,(r:any)=>r.answers.intent.confidence='0.9',(r:any)=>r.model='other',(r:any)=>r.usage.input_tokens=-1]) {const r=response();change(r);mock.mock.mockImplementation(async()=>Response.json(r));await assert.rejects(classifyReviewIntent('Help'),/invalid response/);}
 mock.mock.mockImplementation(async()=>{throw new Error('secret network detail');});await assert.rejects(classifyReviewIntent('Help'),/could not be reached/);
 mock.mock.mockImplementation(async()=>{throw new DOMException('aborted','TimeoutError');});await assert.rejects(classifyReviewIntent('Help'),/20-second/);
});

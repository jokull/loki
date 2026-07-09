const APEX="https://loftur.app";let mcpUrl,KEY,ORIGIN,rid=1;
const results=[];const ok=(l,c,d="")=>{results.push(!!c);console.log(`${c?"✅":"❌"} ${l}${d?" — "+d:""}`);};
async function rpc(m,p){const r=await fetch(mcpUrl,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+KEY},body:JSON.stringify({jsonrpc:"2.0",id:rid++,method:m,params:p})});const ct=r.headers.get("content-type")||"";const t=await r.text();if(r.status>=400)throw new Error("HTTP "+r.status+": "+t.slice(0,200));let j;if(ct.includes("event-stream")){const d=t.split(/\r?\n/).filter(l=>l.startsWith("data:"));j=JSON.parse(d[d.length-1].slice(5).trim());}else j=JSON.parse(t);if(j.error)throw new Error(JSON.stringify(j.error));return j.result;}
const tool=async(n,a={})=>{const r=await rpc("tools/call",{name:n,arguments:a});const x=(r.content||[]).map(c=>c.text||"").join("\n");if(r.isError)throw new Error(`${n}: ${x}`);return x;};
async function site(sub){const su=await(await fetch(APEX+"/api/signup",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({subdomain:sub,email:"jokull@triptojapan.com"})})).json();KEY=su.apiKey;ORIGIN=su.siteUrl;mcpUrl=su.mcpUrl;return su;}
async function main(){
  const t=Math.floor(Date.now()/1000)%100000;
  // list
  await site("tpllist"+t);
  const list=await tool("scaffold_template",{});
  ok("scaffold_template lists templates",/members/.test(list)&&/link-in-bio/.test(list));
  // members
  const scaff=await tool("scaffold_template",{template:"members"});
  ok("scaffold members writes files",/Scaffolded "members"/.test(scaff)&&/routes\/members.tsx/.test(scaff));
  const pub=await tool("publish_site",{message:"members tpl"});const v=(/Published v(\d+)/.exec(pub)||[])[1];
  ok("members template publishes",!!v,"v"+v);
  await new Promise(r=>setTimeout(r,900));
  const home=await(await fetch(ORIGIN+"/")).text();
  ok("members home shows sign-in form",/Members only/.test(home)&&/Email me a link/.test(home));
  const mem=await(await fetch(ORIGIN+"/members")).text();
  ok("members /members gated for anon",/Please <a href="\/">sign in/.test(mem));
  // link-in-bio on a fresh site
  await site("tplbio"+t);
  await tool("scaffold_template",{template:"link-in-bio"});
  const pub2=await tool("publish_site",{message:"bio"});const v2=(/Published v(\d+)/.exec(pub2)||[])[1];
  ok("link-in-bio publishes",!!v2,"v"+v2);
  await new Promise(r=>setTimeout(r,900));
  const bio=await(await fetch(ORIGIN+"/")).text();
  ok("link-in-bio renders profile + links",/Ada Lovelace/.test(bio)&&/GitHub/.test(bio));
  const passed=results.filter(Boolean).length;console.log(`\n${passed}/${results.length}`);process.exit(passed===results.length?0:1);
}
main().catch(e=>{console.error("FATAL",e.message);process.exit(1);});

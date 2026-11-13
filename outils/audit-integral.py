"""Audit intégral de PIVOT : actionne chaque élément cliquable de chaque écran et de chaque
fenêtre, jusqu'à 4 niveaux de profondeur, en remettant les données de test à zéro avant chaque
clic. Relève les erreurs JavaScript, les erreurs console, les requêtes en échec, les boutons
qui rechargent toute la page et les boutons sans réaction visible.

Méthode imposée pour chaque audit (demande du fondateur, 13/11/2026).

Usage :
  python3 -m http.server 8765        (à la racine du dépôt, pour tester avant mise en ligne)
  python3 outils/audit-integral.py   [URL, par défaut http://localhost:8765/index.html]
Rapport : /tmp/audit/crawl/crawl.json
Pré-requis : pip install playwright && playwright install chromium
"""
import asyncio, json, sys, re, os
from collections import deque
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/index.html'
OUT = '/tmp/audit/crawl'; os.makedirs(OUT, exist_ok=True)
SCREENS = ['home', 'roster', 'session', 'match', 'tactics', 'posture']
MAX_DEPTH = 4
# Actions qui quittent l'app, paient, envoient à tous ou suppriment : jamais déclenchées.
DENY = re.compile(r'deleteAccount|resetAll|signOut|logout|doLogout|checkout|Checkout|stripe|Stripe|buyPlan|subscribe|startPay|'
                  r'location\.|window\.open|mailto|tel:|openPlayStore|manageSub|notifyAll|sendPush|broadcast|installApp|'
                  r'importData|\.click\(\)|pickPhoto|takePhoto')

SETUP = """()=>{
  DB.sub={until:Date.now()+864e5*30,plan:'test'};
  const t=T(); t.name='Audit'; t.category='U15';
  t.players=Array.from({length:10},(_,i)=>({id:'pl'+i,first:'Prenom'+i,last:'Nom'+i,num:i+4,pos:['Meneur','Ailier','Pivot'][i%3],present:i!==9,
     injury:i===8?{active:true,zone:'cheville'}:undefined,goal:i===0?'70% LF':''}));
  t.session={title:'Séance audit',blocks:[{title:'Echauffement',cat:'Échauffement',dur:10,intensity:'Faible',points:'x'},
     {title:'Tir',cat:'Tir',dur:15,intensity:'Moyenne',points:'y',exoId:allExos()[0].id}]};
  t.savedSessions=[{id:'ss1',title:'Ancienne',ts:Date.now(),blocks:[{title:'A',cat:'Tir',dur:10}]}];
  t.obs=[{ts:Date.now(),txt:'obs'}];
  t.match={opponent:'Adv',live:true,events:[{id:'e1',pid:'pl0',type:'fg2',made:true,side:'us'},{id:'e2',side:'opp',pts:2,type:'opp'}],
     onCourt:['pl0','pl1','pl2','pl3','pl4']};
  DB.plays=[{title:'Sys',frames:[{tokens:[{id:'a',kind:'off',label:'1',x:250,y:380},{id:'b',kind:'ball',label:'',x:265,y:370}],
     paths:[{type:'move',from:'a',points:[{x:250,y:380},{x:250,y:200}]}]},{tokens:[{id:'a',kind:'off',label:'1',x:250,y:200},
     {id:'b',kind:'ball',label:'',x:265,y:370}],paths:[]}]}];
  save(); window.__SNAP=JSON.stringify(DB); return 'ok'; }"""
RESTORE = """(scr)=>{ try{closeModal()}catch(e){} try{ if(typeof stopTimer==='function')stopTimer(); }catch(e){}
  try{tac.playing=false}catch(e){} DB=JSON.parse(window.__SNAP); try{save()}catch(e){} pvGoTab(scr,{noHistory:true});
  window.scrollTo(0,0); return 1 }"""
LIST = """(zone)=>{ const root = zone==='modal' ? document.getElementById('modalBg') : document.getElementById('main');
  if(!root) return [];
  const els=Array.from(root.querySelectorAll('[onclick],button,a[href],[role=button],summary,.pchip,.sysrow,.tile,.chip,input[type=checkbox],select'));
  const out=[]; const seen=new Set();
  els.forEach((e,i)=>{ const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) return;
    if(getComputedStyle(e).visibility==='hidden') return;
    const oc=(e.getAttribute('onclick')||'').trim();
    const txt=(e.innerText||e.getAttribute('aria-label')||e.title||e.name||e.id||'').trim().replace(/\\s+/g,' ').slice(0,50);
    const key=e.tagName+'|'+(oc||txt).replace(/'[a-z0-9_-]{6,}'/gi,"'ID'").replace(/\\d{4,}/g,'N');
    if(seen.has(key)) return; seen.add(key);
    out.push({key,oc:oc.slice(0,160),txt,tag:e.tagName,hasHandler:!!(oc||e.onclick||e.tagName==='SUMMARY')});
  }); return out; }"""
FIND_CLICK = """([zone,key])=>{ const root = zone==='modal' ? document.getElementById('modalBg') : document.getElementById('main');
  if(!root) return false;
  const els=Array.from(root.querySelectorAll('[onclick],button,a[href],[role=button],summary,.pchip,.sysrow,.tile,.chip,input[type=checkbox],select'));
  for(const e of els){ const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) continue;
    const oc=(e.getAttribute('onclick')||'').trim();
    const txt=(e.innerText||e.getAttribute('aria-label')||e.title||e.name||e.id||'').trim().replace(/\\s+/g,' ').slice(0,50);
    const k=e.tagName+'|'+(oc||txt).replace(/'[a-z0-9_-]{6,}'/gi,"'ID'").replace(/\\d{4,}/g,'N');
    if(k===key){ if(e.tagName==='SELECT'){ if(e.options.length>1){ e.selectedIndex=(e.selectedIndex+1)%e.options.length; e.dispatchEvent(new Event('change',{bubbles:true})); } return true; }
      e.click(); return true; } }
  return false; }"""
SIG = "()=>document.body.innerHTML.length+'|'+(document.getElementById('modalBg')||{className:''}).className+'|'+view+'|'+document.querySelectorAll('[open]').length"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                                  locale='fr-FR', accept_downloads=True)
        pg = await ctx.new_page(); pg.set_default_timeout(5000)
        issues = []; cur = {'s': 'load'}
        stats = {'actions': 0, 'skipped': [], 'inert': [], 'downloads': 0}
        def add(kind, msg): issues.append({'where': cur['s'], 'kind': kind, 'msg': msg[:300]})
        pg.on('pageerror', lambda e: add('JS', str(e)))
        pg.on('console', lambda m: add('console', m.text) if m.type == 'error' and 'snd-' not in m.text
              and 'Failed to load resource' not in m.text else None)
        pg.on('response', lambda r: add('HTTP %d' % r.status, r.url) if r.status >= 400 and 'snd-' not in r.url
              and '/api/' not in r.url else None)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        pg.on('popup', lambda pp: asyncio.ensure_future(pp.close()))
        pg.on('download', lambda d: stats.__setitem__('downloads', stats['downloads'] + 1))

        await pg.goto(URL, wait_until='domcontentloaded'); await pg.wait_for_timeout(3000)
        await pg.click('text=Découvrir sans compte'); await pg.wait_for_timeout(1000)
        await pg.evaluate(SETUP)
        base = pg.url

        async def reboot():
            await pg.goto(base, wait_until='domcontentloaded'); await pg.wait_for_timeout(2500)
            try:
                await pg.click('text=Découvrir sans compte', timeout=2500); await pg.wait_for_timeout(800)
            except Exception:
                pass
            await pg.evaluate(SETUP)

        async def E(js, arg=None):
            for _ in range(3):
                try:
                    return await (pg.evaluate(js, arg) if arg is not None else pg.evaluate(js))
                except Exception as e:
                    if 'context was destroyed' in str(e) or 'navigation' in str(e):
                        add('RELOAD', 'la page s\'est rechargée'); await pg.wait_for_timeout(1500); await reboot()
                    else:
                        raise
            return None

        async def replay(scr, path):
            """Revient à l'écran, données d'origine, puis rejoue la suite de clics menant à la fenêtre visée."""
            await E(RESTORE, scr); await pg.wait_for_timeout(90)
            for i, k in enumerate(path):
                zone = 'main' if i == 0 else 'modal'
                ok = await E(FIND_CLICK, [zone, k])
                if not ok:
                    return False
                await pg.wait_for_timeout(130)
            return True

        visited = set(); seen_modals = set()
        for scr in SCREENS:
            queue = deque([[]])
            while queue:
                path = queue.popleft()
                if not await replay(scr, path):
                    continue
                zone = 'main' if not path else 'modal'
                if path and not await E("()=>{const m=document.getElementById('modalBg');return !!(m&&m.classList.contains('on'))}"):
                    continue
                items = (await E(LIST, zone)) or []
                for it in items:
                    gkey = (scr if not path else '*') + '::' + '>'.join(path[-1:]) + '::' + it['key']
                    if gkey in visited:
                        continue
                    visited.add(gkey)
                    label = it['txt'] or it['oc'][:40]
                    cur['s'] = scr + ' > ' + ' > '.join([p.split('|', 1)[1][:30] for p in path] + [label])
                    if DENY.search(it['oc']) or DENY.search(it['txt']):
                        stats['skipped'].append(cur['s']); continue
                    if not await replay(scr, path):
                        continue
                    before = await E(SIG)
                    try:
                        await pg.evaluate(FIND_CLICK, [zone, it['key']])
                    except Exception as e:
                        if 'context was destroyed' in str(e) or 'navigation' in str(e):
                            add('RELOAD', f"« {label} » recharge toute la page"); await pg.wait_for_timeout(1500); await reboot(); continue
                        add('EXC', f"{label} :: {e}"); continue
                    await pg.wait_for_timeout(200)
                    stats['actions'] += 1
                    if stats['actions'] % 50 == 0:
                        print(f"... {stats['actions']} actions, {len(issues)} problèmes, file d'attente {len(queue)}, fenêtres {len(seen_modals)} ({scr})", flush=True)
                        json.dump({'partiel': True, 'actions': stats['actions'], 'issues': issues, 'inert': stats['inert']},
                                  open(f'{OUT}/crawl.json', 'w'), ensure_ascii=False, indent=1)
                    if pg.url.split('#')[0] != base.split('#')[0]:
                        add('NAV', f"« {label} » quitte l'app vers {pg.url}"); await reboot(); continue
                    after = await E(SIG)
                    if before == after and it['hasHandler']:
                        stats['inert'].append(cur['s'] + '  [' + it['oc'][:70] + ']')
                    opened = await E("()=>{const m=document.getElementById('modalBg');return !!(m&&m.classList.contains('on'))}")
                    if opened and len(path) + 1 < MAX_DEPTH:
                        # une fenêtre déjà explorée (même titre) n'est pas réexplorée par un autre chemin
                        sigm = await E("()=>{const m=document.getElementById('modalBg'); if(!m) return ''; const f=new Set(); m.querySelectorAll('[onclick]').forEach(e=>{const x=(e.getAttribute('onclick')||'').match(/[A-Za-z_]+(?=\\()/g); (x||[]).forEach(n=>f.add(n));}); const h=m.querySelector('h3,h2'); return [...f].sort().join(',')||('titre:'+(h?h.innerText.trim().slice(0,40):''));}")
                        if sigm not in seen_modals:
                            seen_modals.add(sigm); queue.append(path + [it['key']])
        # Barre d'onglets et en-tête
        for sel in ['#tabs button', 'header.top button']:
            n = await E(f"()=>document.querySelectorAll('{sel}').length") or 0
            for i in range(n):
                cur['s'] = f'{sel} #{i}'
                await E(RESTORE, 'home'); await E(f"(i)=>document.querySelectorAll('{sel}')[i].click()", i)
                await pg.wait_for_timeout(300); stats['actions'] += 1
        res = {'url': URL, 'actions': stats['actions'], 'downloads': stats['downloads'], 'issues': issues,
               'inert': stats['inert'], 'skipped': stats['skipped']}
        json.dump(res, open(f'{OUT}/crawl.json', 'w'), ensure_ascii=False, indent=1)
        res['fenetres'] = sorted(seen_modals)
        json.dump(res, open(f'{OUT}/crawl.json', 'w'), ensure_ascii=False, indent=1)
        print(json.dumps({'fenetres': len(seen_modals), 'actions': stats['actions'], 'downloads': stats['downloads'], 'issues': len(issues),
                          'inert': len(stats['inert']), 'skipped': len(stats['skipped'])}, ensure_ascii=False))
        await b.close()

asyncio.run(main())

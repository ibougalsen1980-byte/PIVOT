"""Contrôles transverses de PIVOT : traductions, images, accessibilité, champs, liens.
Usage : python3 outils/audit-transverse.py [URL]   -> /tmp/audit/transverse.json"""
import asyncio, json, sys, re, os
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/index.html'
os.makedirs('/tmp/audit', exist_ok=True)
SCREENS = ['home', 'roster', 'session', 'match', 'tactics', 'posture']
FR = re.compile(r"\b(joueurs?|séances?|entraîn\w+|équipe|exercices?|ajoute[rz]?|enregistr\w+|terrain|aujourd'hui|réglages|semaine|défense|passe|tir|bloc)\b", re.I)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); pg.set_default_timeout(6000)
        await pg.goto(URL, wait_until='domcontentloaded'); await pg.wait_for_timeout(3000)
        await pg.click('text=Découvrir sans compte'); await pg.wait_for_timeout(1000)
        R = {'i18n': {}, 'img': [], 'a11y': {}, 'links': []}
        for lg in ['en', 'es', 'pt']:
            await pg.evaluate(f"()=>setLang('{lg}')"); await pg.wait_for_timeout(500)
            for s in SCREENS:
                await pg.evaluate(f"()=>{{closeModal();pvGoTab('{s}')}}"); await pg.wait_for_timeout(400)
                txt = await pg.evaluate("()=>document.getElementById('main').innerText")
                lines = [l.strip() for l in txt.split('\n') if l.strip() and FR.search(l)]
                R['i18n'][f'{lg}/{s}'] = lines[:12] + ([f'... +{len(lines)-12}'] if len(lines) > 12 else [])
        await pg.evaluate("()=>setLang('fr')"); await pg.wait_for_timeout(400)
        for s in SCREENS:
            await pg.evaluate(f"()=>{{closeModal();pvGoTab('{s}')}}"); await pg.wait_for_timeout(500)
            R['img'] += await pg.evaluate("()=>Array.from(document.images).filter(i=>i.complete&&i.naturalWidth===0&&i.src).map(i=>i.src)")
            R['a11y'][s] = await pg.evaluate("""()=>{
              const vis=e=>{const r=e.getBoundingClientRect();return r.width>1&&r.height>1};
              const noname=Array.from(document.querySelectorAll('#main button,#main [onclick]')).filter(vis).filter(e=>!(e.innerText||'').trim()&&!e.getAttribute('aria-label')&&!e.title).map(e=>e.outerHTML.slice(0,90));
              const small=Array.from(document.querySelectorAll('#main button,#main [onclick]')).filter(vis).filter(e=>{const r=e.getBoundingClientRect();return r.height<28||r.width<28}).map(e=>((e.innerText||e.title||e.getAttribute('aria-label')||'').trim().slice(0,25)||e.outerHTML.slice(0,60))+' '+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height));
              const nolabel=Array.from(document.querySelectorAll('#main input,#main select,#main textarea')).filter(vis).filter(e=>!e.placeholder&&!e.getAttribute('aria-label')&&!(e.id&&document.querySelector('label[for="'+e.id+'"]'))&&!(e.previousElementSibling&&/LABEL/.test(e.previousElementSibling.tagName))).map(e=>e.outerHTML.slice(0,90));
              return {sans_nom:noname, trop_petits:small.slice(0,15), nb_trop_petits:small.length, champs_sans_libelle:nolabel}; }""")
        hrefs = await pg.evaluate("()=>[...new Set(Array.from(document.querySelectorAll('a[href^=\"http\"]')).map(a=>a.href))]")
        for h in hrefs:
            try:
                r = await pg.request.get(h, timeout=8000); R['links'].append([h, r.status])
            except Exception as e:
                R['links'].append([h, 'ERR ' + str(e)[:60]])
        json.dump(R, open('/tmp/audit/transverse.json', 'w'), ensure_ascii=False, indent=1)
        print(json.dumps({'i18n_lignes_fr': {k: len(v) for k, v in R['i18n'].items()}, 'img_cassees': R['img'],
                          'a11y': {k: (len(v['sans_nom']), v['nb_trop_petits'], len(v['champs_sans_libelle'])) for k, v in R['a11y'].items()},
                          'liens': R['links']}, ensure_ascii=False, indent=1))
        await b.close()
asyncio.run(main())

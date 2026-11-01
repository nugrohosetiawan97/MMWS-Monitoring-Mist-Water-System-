const { chromium } = require('playwright');
const SP = '/tmp/claude-0/-home-claude/3861b831-f318-5579-b2cd-7af213f16234/scratchpad/';
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const [w, h, name] of [[1440, 1000, 'cf_desktop'], [390, 844, 'cf_mobile']]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
    console.log(name, 'pill:', await p.textContent('#connPill'), '| notice:', (await p.textContent('#notice')).slice(0, 140));
    await p.screenshot({ path: SP + name + '.png', fullPage: name === 'cf_desktop' });
    if (name === 'cf_desktop') {
      await p.click('#btnSet'); await p.waitForTimeout(400);
      console.log('PIN field hidden:', await p.isHidden('#pinFld2'), '| sim fieldset visible:', await p.isVisible('#simFs'), '|', await p.textContent('#simInfo'));
      await p.screenshot({ path: SP + 'cf_settings.png' });
      await p.keyboard.press('Escape');
      await p.click('#btnInput'); await p.waitForTimeout(300); console.log('Input PIN hidden:', await p.isHidden('#pinFld1')); await p.keyboard.press('Escape');
      await p.click('#btnImport'); await p.waitForTimeout(300); console.log('Import PIN hidden:', await p.isHidden('#pinFld3'), '| imports listed:', (await p.textContent('#dlgImport')).includes('Logsheet Jul'));
      await p.keyboard.press('Escape');
    }
    const sw = await p.evaluate(() => document.documentElement.scrollWidth); console.log(name, 'scrollWidth', sw);
  }
  console.log('errors:', errs.length ? errs : 'none'); await b.close();
})();

import { test, expect } from '@playwright/test';

test('language switches all screens and persists', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('.session-tab.selected')).toContainText('production-api');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('.sidebar .registered-instance')).toHaveCount(5);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to GoTTY Hub' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.session-tab.selected')).toContainText('production-api');
});

test('login and account security are centered, keyboard dismissable dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/?preview=1');
  const trigger = page.getByRole('button', { name: '登录', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(5);
  expect(Math.abs(box.y + box.height / 2 - 480)).toBeLessThan(5);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: '账号与安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号与安全' })).toBeVisible();
  const accountBox = (await dialog.boundingBox())!;
  expect(Math.abs(accountBox.x + accountBox.width / 2 - 720)).toBeLessThan(5);
  await dialog.getByLabel('新密码', { exact: true }).fill('password-one');
  await dialog.getByLabel('确认密码', { exact: true }).fill('password-two');
  await dialog.getByRole('button', { name: '保存密码' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('两次输入的密码不一致。');
});

test('forgot-password flow verifies the demo code before showing new password fields', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '忘记密码？' }).click();
  await dialog.getByRole('textbox', { name: '邮箱', exact: true }).fill('demo@example.com');
  await dialog.getByRole('button', { name: '获取验证码' }).click();
  await dialog.getByLabel('邮箱验证码', { exact: true }).fill('000000');
  await dialog.getByRole('button', { name: '验证并登录' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('请输入演示验证码 123456。');
  await dialog.getByLabel('邮箱验证码', { exact: true }).fill('123456');
  await dialog.getByRole('button', { name: '验证并登录' }).click();
  await expect(dialog.getByLabel('新密码', { exact: true })).toBeVisible();
});

for (const width of [320, 375, 414, 768, 1440]) {
  test(`Chinese and English fit ${width}px, including the login dialog`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?preview=1');
    for (const language of ['zh', 'en']) {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: language === 'zh' ? '登录' : 'Sign in', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
      if (language === 'zh') await page.getByRole('button', { name: 'Switch to English' }).click();
    }
  });
}

test('mobile account settings open from the topbar and close instance navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: '打开实例导航' }).click();
  await page.keyboard.press('Escape');
  await page.locator('.topbar').getByRole('button', { name: '账号与安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号与安全' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('authorization edits remain isolated to the selected instance', async ({ page }) => {
  await page.goto('/?preview=1');
  await page.getByRole('button', { name: '管理 production-api', exact: true }).click();
  await page.getByLabel('新增授权邮箱').fill('new@example.com');
  await page.getByRole('button', { name: '添加操作者' }).click();
  await expect(page.getByRole('dialog').getByText('new@example.com', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '管理 dev-workspace', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('new@example.com', { exact: true })).toHaveCount(0);
});

for (const width of [375, 1440]) {
  test(`terminal workspace maximizes and restores at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900});
    await page.goto('/?preview=1');
  
    await expect(page.locator('.session-tab .terminal-status')).toHaveCount(1);
    await page.getByRole('button',{name:'最大化工作区',exact:true}).click();
    await expect(page.locator('.topbar')).toBeHidden();
    const workspace=await page.locator('.workspace').boundingBox();
    expect(workspace!.x).toBe(0);expect(workspace!.y).toBe(0);
    expect(workspace!.width).toBe(width);expect(workspace!.height).toBe(900);
    await expect(page.getByRole('button',{name:'恢复工作区',exact:true})).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(page.locator('.topbar')).toBeVisible();
    await page.getByRole('button',{name:'最大化工作区',exact:true}).click();
    await page.getByRole('button',{name:'恢复工作区',exact:true}).click();
    await expect(page.locator('.topbar')).toBeVisible();
  });
}

test('favicon messages are scoped to their instance frame and reject unrelated senders',async({page})=>{
  await page.goto('/?preview=1');

  await page.evaluate(()=>{
    const frame=document.createElement('iframe');frame.src='/';frame.dataset.instanceId='prod';frame.hidden=true;document.body.append(frame);
  });
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.readyState==='complete');
  for(const color of ['yellow','green','gray','red']){
    await page.evaluate(color=>document.querySelector('iframe')!.contentWindow!.eval(`parent.postMessage({type:'gotty-favicon',color:'${color}'},location.origin)`),color);
    await expect(page.locator('.session-tab .terminal-status')).toHaveAttribute('data-state',color);
    await expect(page.locator('.sidebar .registered-instance').filter({hasText:'production-api'}).locator('img')).toHaveAttribute('src',`/gotty-status/${color}.svg`);
  }
  await page.evaluate(()=>window.postMessage({type:'gotty-favicon',color:'yellow'},location.origin));
  await expect(page.locator('.session-tab .terminal-status')).toHaveAttribute('data-state','red');
});

test('terminal is the landing page and both add buttons open a centered modal',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/?preview=1');
  await expect(page.locator('.overview')).toHaveCount(0);
  await expect(page.locator('.topbar')).not.toContainText('工作空间');
  for(const scope of ['.sidebar','.terminal-tabs']){
    await page.locator(scope).getByRole('button',{name:'接入实例',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByRole('heading',{name:'接入 GoTTY 实例'})).toBeVisible();
    const box=(await dialog.boundingBox())!;
    expect(Math.abs(box.x+box.width/2-720)).toBeLessThan(5);
    expect(Math.abs(box.y+box.height/2-450)).toBeLessThan(5);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button',{name:'关闭终端标签 production-api',exact:true}).click();
  await expect(page.locator('.terminal-empty')).toBeVisible();
  await page.locator('.sidebar .registered-instance').filter({hasText:'dev-workspace'}).click();
  await expect(page.locator('.session-tab.selected')).toContainText('dev-workspace');
});

test('sidebar and navigation fold independently while connected tabs keep their status dot',async({page})=>{
  await page.goto('/?preview=1');
  await expect(page.locator('.topbar')).not.toContainText('production-api');
  await expect(page.locator('.session-tab img.terminal-status')).toBeVisible();
  await page.getByRole('button',{name:'折叠侧边栏',exact:true}).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('.topbar')).toBeVisible();
  await page.getByRole('button',{name:'折叠导航栏',exact:true}).click();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.session-tab img.terminal-status')).toBeVisible();
  await page.getByRole('button',{name:'展开侧边栏',exact:true}).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.topbar')).toBeHidden();
  await page.getByRole('button',{name:'展开导航栏',exact:true}).click();
  await expect(page.locator('.topbar')).toBeVisible();
  await page.locator('.sidebar .registered-instance').filter({hasText:'dev-workspace'}).click();
  await expect(page.locator('.session-tab img.terminal-status')).toHaveCount(2);
  await expect(page.locator('.sidebar .terminal-offline svg')).toHaveCount(1);
});

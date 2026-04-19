import { expect, test } from 'vitest'

test('弹出窗口应正确显示', async () => {
  const popupPage = await browser.getPopupPage()
  const title = await popupPage.title()
  expect(title).toBeTruthy()
})

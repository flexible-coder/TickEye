// src/background/index.ts

chrome.commands.onCommand.addListener((command) => {
  console.log('command==',command);
  
  if (command === 'toggle_feature') {
    // 获取当前活跃标签页
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        // 向内容脚本发送消息
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_FEATURE' });
      }
    });
  }
});
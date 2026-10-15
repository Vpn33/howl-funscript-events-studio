window.addEventListener('load', function () {
    // 将 URL 参数传递给 sandbox.html
    const params = new URLSearchParams(window.location.search.slice(1));
    const scriptId = params.get('scriptId');
    const eventId = params.get('eventId');
    console.log('params = {}', params);
    if (scriptId && eventId) {
        const iframe = document.getElementById('appFrame');
        // 第二个参数 'chrome-extension://你的扩展ID' 更安全，'*' 表示不限制
        iframe.contentWindow.postMessage({ func: 'edit_event', scriptId, eventId }, '*');
    }
});
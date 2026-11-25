// Download links, OS detection, the one-time relay animation, and screenshot zoom.
(function () {
  const RELEASES = 'https://github.com/noras-salman/baton/releases/latest/download/';

  // Every download points at the newest release; file names never change between versions.
  document.querySelectorAll('.dl').forEach((a) => (a.href = RELEASES + a.dataset.file));

  // Best guess at the visitor's platform. Apple silicon can't be told apart from Intel in
  // most browsers, so Macs default to Apple silicon (what's sold today) with Intel listed below.
  function detect() {
    const ua = navigator.userAgent;
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Mac/i.test(platform) || /Macintosh/.test(ua)) return { os: 'mac', arch: 'arm64', label: 'macOS' };
    if (/Win/i.test(platform) || /Windows/.test(ua)) return { os: 'windows', label: 'Windows' };
    if (/Linux|X11/i.test(platform) && !/Android/i.test(ua)) return { os: 'linux', label: 'Linux' };
    return null;
  }

  const me = detect();
  if (me) {
    const rows = [...document.querySelectorAll('#platforms li')];
    const match = rows.find((li) => li.dataset.os === me.os && (!me.arch || li.dataset.arch === me.arch));
    if (match) {
      match.classList.add('match');
      const link = match.querySelector('.dl');
      const primary = document.getElementById('primary-download');
      primary.href = link.href;
      primary.querySelector('.btn-label').textContent = `Download for ${me.label}`;
      document.getElementById('primary-sub').textContent =
        me.os === 'mac' ? 'Apple silicon · Intel build below' : me.os === 'windows' ? 'Windows 10 and 11 · beta' : 'AppImage · .deb below · beta';
      document.getElementById('detected').textContent = `We picked the ${me.label} build for you. Other platforms are listed too.`;
    }
  }

  // Play the relay once, when it scrolls into view (it's in the hero, so usually right away).
  const relay = document.querySelector('.relay');
  if (relay && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        relay.classList.add('go');
        io.disconnect();
      }
    });
    io.observe(relay);
  } else if (relay) relay.classList.add('go');

  // Click a screenshot to see it full size.
  const zoom = document.getElementById('zoom');
  const zoomImg = zoom.querySelector('img');
  document.querySelectorAll('[data-zoom]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const img = btn.querySelector('img');
      zoomImg.src = img.currentSrc || img.src;
      zoomImg.alt = img.alt;
      zoom.showModal();
    }),
  );
  zoom.addEventListener('click', () => zoom.close());
  zoom.querySelector('.zoom-close').addEventListener('click', () => zoom.close());
})();

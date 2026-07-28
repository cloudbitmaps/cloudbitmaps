/**
 * The /demo replay stepper.
 *
 * PROGRESSIVE ENHANCEMENT IS THE WHOLE DESIGN. Without this file the page shows all four beats stacked, the
 * key axis in its final state, and both provenance tables — every claim the page makes is already readable.
 * This script narrows that to one beat at a time and animates the sweep between them. It adds pacing, not
 * information, which is why the controls are `hidden` in the markup and revealed here: a Play button that
 * cannot play is worse than no button.
 *
 * Written as plain ES5-compatible script (no modules, no build step) to match `site/` and `site-final/`.
 *
 * Two rules it has to honour, both from the site's animation contract:
 *   · Only `opacity` and `transform` are animated. The playhead is a transform-translated element, never a
 *     `left` offset, because a constant-velocity travel animating `left` forces layout every frame.
 *   · Under `prefers-reduced-motion` the figure JUMPS to each beat's final state. The motion is what gets
 *     dropped; the information never does.
 */
(function () {
  'use strict';

  var root = document.getElementById('replay');
  if (!root) return;

  var num = function (name) {
    return Number(root.getAttribute('data-' + name));
  };

  var AXIS = num('axis');
  var SHARED_TO = num('shared-to');
  var SHARED = num('shared');
  var SKIPPED = num('skipped');
  var BYTES = num('bytes');

  var tabs = [].slice.call(root.querySelectorAll('.beat-tab'));
  var beats = [].slice.call(root.querySelectorAll('.beat'));
  var head = document.getElementById('axis-head');
  var controls = document.getElementById('controls');
  var btnPrev = document.getElementById('prev');
  var btnNext = document.getElementById('next');
  var btnPlay = document.getElementById('play');

  var out = {
    compared: document.getElementById('t-compared'),
    aligned: document.getElementById('t-aligned'),
    skipped: document.getElementById('t-skipped'),
    bytes: document.getElementById('t-bytes'),
  };

  var reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    reduced = false;
  }

  // ── the inset: keys 80-119, one cell each ───────────────────────────────────────────────────────────────
  // Built here rather than written out as forty elements of markup, because the boundary it demonstrates is
  // derived from the same data attributes the rest of the figure reads. Hand-writing the cells would let the
  // inset disagree with the axis above it.
  // The cells live in the markup so the figure is complete with no JavaScript; this only adopts them.
  // `scripts/site-replay.cjs --check` verifies their shared/A-only split against the benchmark, so the
  // markup cannot drift from the axis above it.
  var cells = [].slice.call(root.querySelectorAll('.icell')).map(function (el) {
    return { el: el, key: Number(el.getAttribute('data-key')) };
  });

  // ── counters ────────────────────────────────────────────────────────────────────────────────────────────
  var fmt = function (n) {
    return Math.round(n).toLocaleString('en-US');
  };

  function setTally(compared, aligned, skipped, bytes) {
    out.compared.textContent = fmt(compared);
    out.aligned.textContent = fmt(aligned);
    out.skipped.textContent = fmt(skipped);
    out.bytes.textContent = fmt(bytes);
  }

  // ── beat states ─────────────────────────────────────────────────────────────────────────────────────────
  // Each entry is the figure's RESTING state for that beat: where the playhead sits, what the counters read,
  // and which classes the stage carries. `sweep` marks the one beat whose transition is worth animating.
  var STATES = [
    { head: 0, tally: [0, 0, 0, 0], cls: '', sweep: false },
    { head: 1, tally: [AXIS, SHARED, 0, 0], cls: 'is-compared', sweep: true },
    {
      head: 1,
      tally: [AXIS, SHARED, SKIPPED, BYTES],
      cls: 'is-compared is-fetched',
      sweep: false,
      count: true,
    },
    {
      head: 1,
      tally: [AXIS, SHARED, SKIPPED, BYTES],
      cls: 'is-compared is-fetched is-done',
      sweep: false,
    },
  ];

  var current = -1;
  var raf = null;
  var playing = false;

  function stopSweep() {
    if (raf !== null) {
      window.cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function placeHead(t) {
    // translateX in percent of the head's own width would be meaningless; the track is the reference, so the
    // head spans it and is translated by a fraction of the track.
    head.style.transform = 'translateX(' + t * 100 + '%)';
    head.style.opacity = t > 0 && t < 1 ? '1' : '0';
  }

  /**
   * Beat 02, in two phases — and the reason is a pacing bug worth recording.
   *
   * A single linear sweep across all 4,000 keys put the aligned counter at 100 within a quarter of a second,
   * because the 100 shared keys are the first 2.5% of the axis. The moment the whole page is about was over
   * before a reader could see it, followed by seven seconds of a playhead travelling past a static number.
   *
   * So the comparison is shown twice, at two scales, each timed to its own:
   *
   *   Phase A — the INSET, 40 keys at roughly 90ms each. Slow enough to watch cells light one at a time,
   *             cross the boundary at key 100, and stop being cyan. This is where a reader learns WHY.
   *   Phase B — the AXIS, all 4,000 keys. The "compared" counter climbs to 4,000 while "aligned" holds at
   *             100, which now reads as a conclusion rather than a number that appeared.
   *
   * Both are linear. Easing a playhead across a measured axis would imply the comparison itself sped up and
   * slowed down, which is a claim about the algorithm rather than a flourish.
   */
  var INSET_MS = 3600;
  var AXIS_MS = 4200;

  function sweep(done) {
    var start = null;
    stopSweep();

    function phaseA(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / INSET_MS);
      var upto = cells.length ? cells[0].key + t * cells.length : 0;
      cells.forEach(function (c) {
        c.el.classList.toggle('is-seen', c.key <= upto);
      });
      // The axis head waits: two things moving at once would split attention between the scale that explains
      // and the scale that concludes.
      placeHead(0);
      if (t < 1) {
        raf = window.requestAnimationFrame(phaseA);
      } else {
        start = null;
        raf = window.requestAnimationFrame(phaseB);
      }
    }

    function phaseB(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / AXIS_MS);
      placeHead(t);
      var comparedNow = t * AXIS;
      // Aligned tracks the shared prefix, so it fills during the first sliver and then holds — which is the
      // point of phase B: the head keeps going and finds nothing more.
      var alignedNow = Math.min(SHARED, (comparedNow / SHARED_TO) * SHARED);
      setTally(comparedNow, alignedNow, 0, 0);
      if (t < 1) {
        raf = window.requestAnimationFrame(phaseB);
      } else {
        raf = null;
        if (done) done();
      }
    }

    cells.forEach(function (c) {
      c.el.classList.remove('is-seen');
    });
    raf = window.requestAnimationFrame(phaseA);
  }

  function show(i, opts) {
    var animate = !!(opts && opts.animate) && !reduced;
    if (i < 0) i = 0;
    if (i > STATES.length - 1) i = STATES.length - 1;
    var forward = i > current;
    current = i;
    var s = STATES[i];

    tabs.forEach(function (t, n) {
      var on = n === i;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    beats.forEach(function (b, n) {
      b.classList.toggle('is-on', n === i);
    });

    // classList, not `className =`: assigning the whole attribute wiped `is-interactive` (added just before
    // the first show()) and silently reverted the figure to its no-JS presentation.
    ['is-compared', 'is-fetched', 'is-done'].forEach(function (c) {
      root.classList.toggle(c, s.cls.indexOf(c) !== -1);
    });
    cells.forEach(function (c) {
      c.el.classList.toggle('is-seen', i >= 1);
    });

    stopSweep();
    if (animate && forward && s.sweep) {
      setTally(0, 0, 0, 0);
      sweep(function () {
        setTally(s.tally[0], s.tally[1], s.tally[2], s.tally[3]);
        placeHead(1);
        syncPlayLabel();
        if (playing) window.setTimeout(advance, 2400);
      });
      return;
    }
    if (animate && forward && s.count) {
      placeHead(s.head);
      setTally(AXIS, SHARED, 0, 0);
      countUp(function () {
        syncPlayLabel();
        if (playing) window.setTimeout(advance, 3600);
      });
      return;
    }

    placeHead(s.head);
    setTally(s.tally[0], s.tally[1], s.tally[2], s.tally[3]);
    syncPlayLabel();
    // A beat with no motion still needs time to be READ, and these beats carry a paragraph each. The last one
    // holds longest because it is the conclusion, and stopping on it immediately would throw it away.
    if (playing) window.setTimeout(advance, i === STATES.length - 1 ? 6000 : 4200);
  }

  // The label depends on `current`, so it has to be refreshed AFTER a move rather than only inside
  // setPlaying() — which reads the beat being left, not the one being landed on.
  function syncPlayLabel() {
    btnPlay.textContent = playing ? 'Pause' : current >= STATES.length - 1 ? 'Replay' : 'Play';
  }

  /**
   * Beat 03's counters. The bytes figure climbing from zero is the only way the page shows that the fetch is
   * a consequence of the comparison rather than something that happened alongside it. Text, not CSS, so it
   * cannot be a keyframe — but it is a number changing in place, and the cell is fixed-width, so nothing
   * reflows around it.
   */
  function countUp(done) {
    var DURATION = 1800;
    var start = null;
    stopSweep();
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / DURATION);
      // ease-out: a byte counter that decelerates reads as arriving somewhere, which it is
      var e = 1 - Math.pow(1 - t, 3);
      setTally(AXIS, SHARED, SKIPPED * e, BYTES * e);
      if (t < 1) {
        raf = window.requestAnimationFrame(frame);
      } else {
        raf = null;
        setTally(AXIS, SHARED, SKIPPED, BYTES);
        if (done) done();
      }
    }
    raf = window.requestAnimationFrame(frame);
  }

  function advance() {
    if (!playing) return;
    if (current >= STATES.length - 1) {
      setPlaying(false);
      return;
    }
    show(current + 1, { animate: true });
  }

  function setPlaying(on) {
    playing = on;
    syncPlayLabel();
    if (on) {
      if (current >= STATES.length - 1) show(0, { animate: false });
      advance();
    } else {
      stopSweep();
    }
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      setPlaying(false);
      show(Number(t.getAttribute('data-beat')), { animate: true });
    });
  });
  btnPrev.addEventListener('click', function () {
    setPlaying(false);
    show(current - 1, { animate: false });
  });
  btnNext.addEventListener('click', function () {
    setPlaying(false);
    show(current + 1, { animate: true });
  });
  btnPlay.addEventListener('click', function () {
    setPlaying(!playing);
  });

  // Arrow keys, but only while the replay has focus — hijacking them page-wide would break normal scrolling.
  root.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') {
      setPlaying(false);
      show(current + 1, { animate: true });
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      setPlaying(false);
      show(current - 1, { animate: false });
      e.preventDefault();
    }
  });

  controls.hidden = false;
  root.classList.add('is-interactive');
  // Beat 01 without animation: arriving on the page mid-sweep would show a figure already in progress, which
  // reads as something having been missed.
  show(0, { animate: false });

  /**
   * Autoplay, but only once and only when the figure is actually on screen.
   *
   * Three things it deliberately does NOT do. It does not loop — a figure that restarts while you are reading
   * beat 03 pulls you back to the beginning, and this one is an argument with an ending. It does not start
   * while scrolled past, which is why the trigger is an IntersectionObserver rather than a timer. And it does
   * not autoplay under `prefers-reduced-motion`: the reader who asked for less motion gets beat 01 at rest
   * with the rail and controls right there.
   *
   * Any interaction cancels it for good — once you have taken the wheel, the page must not take it back.
   */
  var autoplayed = false;
  function startAutoplay() {
    if (autoplayed || reduced || playing) return;
    autoplayed = true;
    setPlaying(true);
  }
  ['click', 'keydown'].forEach(function (evt) {
    root.addEventListener(evt, function () {
      autoplayed = true;
    });
  });
  if (typeof window.IntersectionObserver === 'function') {
    var io = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            io.disconnect();
            // A short beat before it moves, so the figure is legible at rest first.
            window.setTimeout(startAutoplay, 700);
          }
        });
      },
      { threshold: 0.35 },
    );
    io.observe(root);
  } else {
    window.setTimeout(startAutoplay, 900);
  }
})();

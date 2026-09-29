/*
 * The theme toggle — the only client-side state on this site.
 *
 * The *applying* of the theme already happened: an inline script in `<head>` sets `data-theme` on the root
 * before first paint, because a deferred script would let the page paint dark and then flip. This file only
 * syncs the visible control to that decision and writes changes back.
 *
 * `prefers-color-scheme` is consulted only as an initial value when nothing has been stored, and the OS
 * listener below stops mattering the moment a visitor makes an explicit choice.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cb-theme';
  var root = document.documentElement;

  /** localStorage throws in private mode on some browsers; a broken toggle must not break the page. */
  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function store(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      /* nothing to do — the theme still applies for this page view */
    }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var checked = document.getElementById('cb-theme-' + theme);
    if (checked) checked.checked = true;
  }

  // Reflect whatever the head script settled on, so the control never disagrees with the page.
  apply(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  var inputs = document.querySelectorAll('input[name="cb-theme"]');
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener('change', function (event) {
      var theme = event.target.value === 'light' ? 'light' : 'dark';
      apply(theme);
      store(theme);
    });
  }

  // Follow the OS only while the visitor has expressed no preference of their own.
  if (window.matchMedia) {
    var query = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function (event) {
      if (readStored() === null) apply(event.matches ? 'light' : 'dark');
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
  }
})();

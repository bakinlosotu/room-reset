// Built-in micro-steps. Used for the spot picker, and as a free fallback
// whenever photo analysis is unavailable, slow or rate-limited.
// Every step names one object, one action and one place, and takes 2 minutes or less.
(function () {
  'use strict';

  const SPOTS = {
    bed: {
      label: 'Bed',
      steps: [
        { effort: 'tiny', text: 'Put your pillows back at the head of the bed' },
        { effort: 'tiny', text: 'Move your phone charger from the bed to your bedside table' },
        { effort: 'tiny', text: 'Take one cup or plate off the bed and put it by the door for the kitchen' },
        { effort: 'small', text: 'Pull your duvet straight so it covers the bed' },
        { effort: 'small', text: 'Put any clothes on the bed into one pile on the chair' },
        { effort: 'small', text: 'Fold the blanket at the end of your bed' },
        { effort: 'a bit more', text: 'Sort the clothes on your bed: clean ones into a drawer, worn ones into the laundry basket' },
        { effort: 'a bit more', text: 'Take one pillowcase off and put it in the laundry basket' }
      ]
    },
    floor: {
      label: 'Floor',
      steps: [
        { effort: 'tiny', text: 'Pick up 5 things from the floor and put them on your bed' },
        { effort: 'tiny', text: 'Put the shoes by your door side by side' },
        { effort: 'tiny', text: 'Put any rubbish on the floor near you in the bin' },
        { effort: 'small', text: 'Put the clothes on the floor into the laundry basket' },
        { effort: 'small', text: 'Move the cups and plates on the floor to one spot by the door' },
        { effort: 'small', text: 'Pick up the paper on the floor and stack it on your desk' },
        { effort: 'a bit more', text: 'Clear the floor just inside your door, putting each thing on your bed' },
        { effort: 'a bit more', text: 'Put every pair of shoes on the floor back where shoes live' }
      ]
    },
    desk: {
      label: 'Desk',
      steps: [
        { effort: 'tiny', text: 'Put the pens on your desk into one cup or pot' },
        { effort: 'tiny', text: 'Take one cup off your desk and put it by the door for the kitchen' },
        { effort: 'tiny', text: 'Put any wrappers on your desk in the bin' },
        { effort: 'small', text: 'Stack the papers on your desk into one pile' },
        { effort: 'small', text: 'Gather the cables on your desk into one corner' },
        { effort: 'small', text: 'Move anything that isn’t for working from the desk to the bed' },
        { effort: 'a bit more', text: 'Clear the space in front of your chair, pushing things into one pile at the back of the desk' },
        { effort: 'a bit more', text: 'Wipe the clear part of your desk with a cloth or tissue' }
      ]
    },
    chair: {
      label: 'Chair',
      steps: [
        { effort: 'tiny', text: 'Hang the top item on your chair on a hanger or hook' },
        { effort: 'tiny', text: 'Move your bag off the chair and hang it on the door handle' },
        { effort: 'tiny', text: 'Put any cups on or near the chair by the door for the kitchen' },
        { effort: 'small', text: 'Put the worn clothes on the chair into the laundry basket' },
        { effort: 'small', text: 'Fold the top 3 clean items on your chair and put them on the bed' },
        { effort: 'a bit more', text: 'Clear the chair: clean clothes into the wardrobe, worn ones into the laundry basket' }
      ]
    },
    wardrobe: {
      label: 'Wardrobe',
      steps: [
        { effort: 'tiny', text: 'Close every wardrobe and drawer door that’s open' },
        { effort: 'tiny', text: 'Pick up one fallen item in your wardrobe and hang it back up' },
        { effort: 'small', text: 'Put the shoes at the bottom of your wardrobe into pairs' },
        { effort: 'small', text: 'Refold the clothes on top of one drawer' },
        { effort: 'a bit more', text: 'Put 3 things you no longer wear into a bag for charity' }
      ]
    },
    anywhere: {
      label: 'Anywhere',
      steps: [
        { effort: 'tiny', text: 'Pick up 5 things from the floor and put them on your bed' },
        { effort: 'tiny', text: 'Put one cup or plate by the door for the kitchen' },
        { effort: 'tiny', text: 'Put 3 bits of rubbish you can see from where you’re standing in the bin' },
        { effort: 'tiny', text: 'Open the curtains or a window' },
        { effort: 'small', text: 'Put the clothes on the floor into the laundry basket' },
        { effort: 'small', text: 'Pull your duvet straight so it covers the bed' },
        { effort: 'small', text: 'Gather the cups and plates in your room into one spot by the door' },
        { effort: 'a bit more', text: 'Clear the top of your bedside table, putting each thing where it lives' }
      ]
    }
  };

  // Which efforts to offer at each "Something easier" level.
  const LEVELS = [
    ['tiny', 'small', 'a bit more'],
    ['tiny', 'tiny', 'small'],
    ['tiny', 'tiny', 'tiny']
  ];
  const RANK = { tiny: 0, small: 1, 'a bit more': 2 };

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pick(spotKey, level, avoid, count) {
    const pool = shuffle((SPOTS[spotKey] || SPOTS.anywhere).steps);
    const wanted = LEVELS[Math.min(level || 0, LEVELS.length - 1)];
    const skip = new Set(avoid || []);
    const chosen = [];
    const take = (test) => {
      const found = pool.find((s) => !chosen.includes(s) && !skip.has(s.text) && test(s));
      if (found) chosen.push(found);
      return found;
    };
    for (const effort of wanted.slice(0, count || 3)) {
      take((s) => s.effort === effort) || take((s) => RANK[s.effort] <= RANK[effort]);
    }
    // Ran out of unseen steps this small here: borrow unseen ones of the same size from
    // "anywhere" before repeating, and never top up with a bigger step than was asked for.
    const largest = Math.max(...wanted.map((e) => RANK[e]));
    const fits = (s) => !chosen.includes(s) && RANK[s.effort] <= largest;
    const anywhere = shuffle(SPOTS.anywhere.steps);
    while (chosen.length < (count || 3)) {
      const fresh = (s) => fits(s) && !chosen.some((c) => c.text === s.text);
      const next = anywhere.find((s) => fresh(s) && !skip.has(s.text)) ||
        pool.find(fits) ||
        anywhere.find(fresh) ||
        pool.find((s) => !chosen.includes(s));
      if (!next) break;
      chosen.push(next);
    }
    return chosen.map((s) => ({ text: s.text, effort: s.effort, safety: null }));
  }

  window.Library = {
    spots: Object.keys(SPOTS).map((key) => ({ key, label: SPOTS[key].label })),
    forSpot: (spot, level, avoid, count) => pick(spot, level, avoid, count),
    starter: (level, avoid, count) => pick('anywhere', level, avoid, count)
  };
})();

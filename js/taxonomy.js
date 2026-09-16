// Dropdown taxonomy for the question writer.
// Derived from the Master Sheet so the options match your existing data.
// You can freely add/rename entries here — the UI rebuilds from this file.

export const TUB = [
  { value: 'TU', label: 'Toss-Up (TU)' },
  { value: 'B', label: 'Bonus (B)' },
];

export const TYPES = [
  { value: 'MC', label: 'Multiple Choice (MC)' },
  { value: 'SA', label: 'Short Answer (SA)' },
];

export const SUBJECTS = [
  'Biology',
  'Chemistry',
  'Earth and Space',
  'Energy',
  'Math',
  'Physics',
];

// Subject -> list of subcategories. Pulled from the aggregated master sheet.
export const SUBCATEGORIES = {
  'Biology': [
    'A & P',
    'Biochem',
    'Cell Bio',
    'Genetics & Evolution',
    'Organismal',
    'Plants & Eco',
    'Other',
  ],
  'Chemistry': [
    'Electrochemistry',
    'Equilibria',
    'IMFs',
    'Kinetics',
    'Nuclear',
    'Organic',
    'Qualitative & Inorganic',
    'Quantum',
    'Thermo & Gases',
    'Trends/Structure',
    'Other',
  ],
  'Earth and Space': [
    'Galaxies/Cosmo',
    'Geology',
    'Meteorology',
    'Misc Astro',
    'Oceanography',
    'Solar System/Planetary',
    'Stellar',
    'Other',
  ],
  'Energy': [
    'Bio - Energy',
    'Chem - Energy',
    'CS - Energy',
    'ESS - Energy',
    'Electrochemistry',
    'Math - Energy',
    'Physics - Energy',
  ],
  'Math': [
    'Algebra',
    'Arithmetic',
    'Calculus',
    'Counting & Probability',
    'Geometry',
    'Linear Algebra',
    'Number Theory',
    'Statistics',
    'Trivia',
    'Other',
  ],
  'Physics': [
    'Circuits',
    'E&M',
    'Fluids & Thermo (FT)',
    'Mechanics',
    'Oscillations, Waves & Optics (O)',
    'Particle',
    'Quantum and Relativity (QR)',
    'Thermo & Gases',
    'Other',
  ],
};

export const DIFFICULTIES = [
  { value: 1, label: 'Easy Round Robin' },
  { value: 2, label: 'Harder Round Robin or Very Early DE' },
  { value: 3, label: 'Early DE' },
  { value: 4, label: 'Mid DE' },
  { value: 5, label: 'Late DE / Finals' },
];

export const MC_SLOTS = ['W', 'X', 'Y', 'Z'];

// Default composition of a compiled round: how many Toss-up / Bonus PAIRS come
// from each subject. Four of every main category plus three Energy = 23 pairs,
// matching the BSBcompile `round_composition = [4, 4, 4, 4, 4, 3]`.
export const ROUND_COMPOSITION = [
  { subject: 'Biology', pairs: 4 },
  { subject: 'Chemistry', pairs: 4 },
  { subject: 'Earth and Space', pairs: 4 },
  { subject: 'Math', pairs: 4 },
  { subject: 'Physics', pairs: 4 },
  { subject: 'Energy', pairs: 3 },
];

export function subcatsFor(subject) {
  return SUBCATEGORIES[subject] || [];
}

export function subjectLabel(s) {
  return s;
}

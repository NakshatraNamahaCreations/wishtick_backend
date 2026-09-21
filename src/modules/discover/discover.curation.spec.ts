import { fallbackShelves, relationWord } from 'src/modules/taste/taste.curation';
import { audienceKeywords, nameForTitle } from './discover.curation';

describe('the name a shelf title uses', () => {
  it.each([
    ['Dashu Birthday', 'Birthday', 'Dashu'],
    ['birthday dashu', 'Birthday', 'dashu'],
    ["Dashu's Birthday", 'Birthday', 'Dashu'],
    ['Amma Anniversary', 'Anniversary', 'Amma'],
  ])('"%s" for %s is "%s"', (name, occasion, expected) => {
    expect(nameForTitle(name, occasion)).toBe(expected);
  });

  it('leaves a name without the occasion alone', () => {
    expect(nameForTitle('Siya', 'Birthday')).toBe('Siya');
    // Its "'s" belongs to it.
    expect(nameForTitle("Priya's Mom", 'Birthday')).toBe("Priya's Mom");
  });

  it('does not strip the occasion out of a longer word', () => {
    expect(nameForTitle('Birthdayboy Raj', 'Birthday')).toBe('Birthdayboy Raj');
  });

  it('keeps a name that is nothing but the occasion', () => {
    expect(nameForTitle('Birthday', 'Birthday')).toBe('Birthday');
  });
});

describe('the words a person shelf searches with', () => {
  it('says the occasion and who it is for', () => {
    expect(audienceKeywords('birthday', relationWord('Dad'))).toBe('birthday for dad');
    expect(audienceKeywords('baby_shower', relationWord('My sister'))).toBe(
      'baby shower for sister',
    );
  });

  it('uses the matched word, never what was typed', () => {
    expect(audienceKeywords('birthday', relationWord('My BEST friend!!'))).toBe(
      'birthday for friend',
    );
  });

  it('adds nothing without a relation it recognises', () => {
    expect(audienceKeywords('birthday', relationWord(''))).toBeNull();
    expect(audienceKeywords('birthday', relationWord('neighbour'))).toBeNull();
  });

  it('leaves out an occasion it does not know', () => {
    expect(audienceKeywords('other', relationWord('Mom'))).toBe('for mom');
  });
});

describe('the shelves a person shelf falls back to', () => {
  it('starts with what the occasion and relation agree on, never the chosen one', () => {
    // Birthday + Mom chose beauty; nothing else is on both lists, so the
    // occasion's own order follows.
    expect(fallbackShelves('birthday', 'Mom')).toEqual([
      'electronics',
      'fashion',
      'experiences',
      'home',
      'jewellery',
    ]);
  });

  it('is the rest of the occasion without a relation', () => {
    expect(fallbackShelves('birthday', null)).toEqual(['fashion', 'beauty', 'experiences']);
  });
});

/**
 * Onboarding is a server-defined sequence so the flow can change without an app
 * release, and so `completed` means the same thing to every client.
 */
export enum OnboardingStep {
  PROFILE = 'profile',
  INTERESTS = 'interests',
  SIZES = 'sizes',
  GIFTING = 'gifting',
  OCCASIONS = 'occasions',
}

export interface StepDefinition {
  step: OnboardingStep;
  title: string;
  description: string;
  /**
   * A required step must be saved before /onboarding/complete succeeds.
   *
   * Only `profile` is required. The rest is personalization: blocking someone
   * from using the product because they will not pick a favourite colour trades
   * a real signup for data we can collect later anyway.
   */
  required: boolean;
  order: number;
}

export const ONBOARDING_STEPS: StepDefinition[] = [
  {
    step: OnboardingStep.PROFILE,
    title: 'About you',
    description: 'Your name, birthday, and timezone',
    required: true,
    order: 1,
  },
  {
    step: OnboardingStep.INTERESTS,
    title: 'Interests & hobbies',
    description: 'What you are into, so gifts land better',
    required: false,
    order: 2,
  },
  {
    step: OnboardingStep.SIZES,
    title: 'Sizes & colours',
    description: 'Clothing fit, shoe size, and colours you love',
    required: false,
    order: 3,
  },
  {
    step: OnboardingStep.GIFTING,
    title: 'Gifting preferences',
    description: 'Categories and lifestyle so suggestions fit you',
    required: false,
    order: 4,
  },
  {
    step: OnboardingStep.OCCASIONS,
    title: 'Occasions',
    description: 'The moments you celebrate',
    required: false,
    order: 5,
  },
];

export const REQUIRED_STEPS: OnboardingStep[] = ONBOARDING_STEPS.filter((s) => s.required).map(
  (s) => s.step,
);

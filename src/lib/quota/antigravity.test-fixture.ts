export const ANTIGRAVITY_SUMMARY_FIXTURE = {
  groups: [
    {
      displayName: "Gemini Models",
      description: "Gemini shared quota",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-08-31T08:00:00Z",
          remainingFraction: 0.72,
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-08-25T13:00:00Z",
          remainingFraction: 0.45,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-08-30T08:00:00Z",
          remainingFraction: 0.38,
        },
        {
          bucketId: "3p-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-08-25T12:30:00Z",
          remainingFraction: 0.8,
        },
      ],
    },
  ],
};

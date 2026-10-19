/** Slack / queue copy sent for first-touch onboarding. */

const CHANNEL = "#fieldcam-selfhost";
const LEADERBOARD = "https://fieldcam.example/#/leaderboard";
const GUIDE = "https://fieldcam.example/guide";

export function onboardingMessage(): string {
  return [
    "Hello, and thanks for joining the FieldCam self-host competition.",
    "",
    `Post findings in ${CHANNEL}. The weekly leaderboard is at ${LEADERBOARD}.`,
    `Setup steps live in the guide: ${GUIDE}.`,
    "",
    "1. Register the camera to yourself in Fleet.",
    "2. Check it out in the app, then record and upload.",
    "3. Return it from the Devices page when you are done.",
    "",
    "Questions go to Alice Chen (alice@northline.example).",
  ].join("\n");
}

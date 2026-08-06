import { UnseenExperience } from "./components/unseen-experience";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return (
    <UnseenExperience
      viewer={
        user
          ? {
              displayName: user.displayName,
              email: user.email,
            }
          : null
      }
      signInPath={chatGPTSignInPath("/")}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}

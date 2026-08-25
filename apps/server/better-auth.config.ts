import { oauthDeviceAuthorization, oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

export const auth = betterAuth({
  basePath: "/",
  baseURL: "http://localhost:3000",
  emailAndPassword: {
    autoSignIn: false,
    enabled: true,
  },
  plugins: [jwt(), oauthProvider({}), oauthDeviceAuthorization()],
});

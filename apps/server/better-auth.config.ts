import { betterAuth } from "better-auth";

export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  emailAndPassword: {
    autoSignIn: false,
    enabled: true,
  },
});

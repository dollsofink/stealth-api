import { ApiPoster } from "./helpers/api-client.mjs";
import { CookieJar } from "tough-cookie";

// 1) Simple: set a cookie and send it automatically (Node)
const client = new ApiPoster({ url: "https://example.com/api" });
await client.setCookie({ name:"sid", value:"abc", sameSite:"Lax", secure:true });
await client.get(); // Cookie header is attached; Set-Cookie responses are captured

// 2) Share a jar across endpoints
const jar = new CookieJar();
const A = new ApiPoster({ url: "https://example.com/a", cookieJar: jar });
const B = new ApiPoster({ url: "https://example.com/b" }).useCookieJar(jar);
await A.post({ login:"x", pass:"y" });
await B.get(); // will carry the session cookies from A

// 3) Seed cookies in the constructor
const seeded = new ApiPoster({
  url: "https://example.com",
  cookies: [
    "prefs=blue; Path=/; SameSite=Lax",
    { name:"sid", value:"xyz", secure:true }
  ]
});
await seeded.get();

// 4) Inspect or clear cookies
console.log(await seeded.getCookies());   // tough-cookie Cookie[]
await seeded.clearCookies();
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { accountingRouter } from "./routers/accounting";
import { posRouter } from "./routers/pos";
import { purchasingRouter } from "./routers/purchasing";
import { programsRouter } from "./routers/programs";
import { workspaceRouter } from "./routers/workspace";

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(getSessionCookieName(ctx.req), {
        ...cookieOptions,
        maxAge: -1,
      });
      return {
        success: true,
      } as const;
    }),
  }),

  workspace: workspaceRouter,
  pos: posRouter,
  purchasing: purchasingRouter,
  accounting: accountingRouter,
  programs: programsRouter,
});

export type AppRouter = typeof appRouter;

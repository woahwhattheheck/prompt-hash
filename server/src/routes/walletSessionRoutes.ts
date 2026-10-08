import { Router } from "express";
import { walletSessionHandler } from "../auth/walletPrincipalHttp";

export const walletSessionRouter = Router();
walletSessionRouter.all("/", walletSessionHandler);

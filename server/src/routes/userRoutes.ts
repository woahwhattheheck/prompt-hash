import express from "express";
import { requireWalletPrincipal } from "../auth/walletPrincipalHttp";
import { CreateUser, GetUsers, GetPayoutSettings, UpdatePayoutSettings } from "../controllers/controllers";

export const userRouter = express.Router();

userRouter.route("/").post(requireWalletPrincipal, CreateUser);

userRouter.route("/").get(GetUsers);

userRouter.route("/:walletAddress/payout-settings")
  .get(requireWalletPrincipal, GetPayoutSettings)
  .post(requireWalletPrincipal, UpdatePayoutSettings);

// src/controllers/subscriptionController.ts
import { Request, Response } from "express";
import { prisma } from "../prisma";

export const getSubscriptions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const subs = await prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    res.json({ subscriptions: subs });
  } catch (error) {
    console.error("Get subscriptions error:", error);
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
};

export const createSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Input validation
    const {
      provider,
      product,
      amount,
      tag,
      currency,
      startDate,
      expiryDate,
      nextBilling,
    } = req.body;

    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ error: "Provider is required" });
    }

    if (amount && (typeof amount !== "number" || amount <= 0)) {
      return res
        .status(400)
        .json({ error: "Amount must be a positive number" });
    }

    if (currency && typeof currency !== "string") {
      return res.status(400).json({ error: "Invalid currency" });
    }

    const newSub = await prisma.subscription.create({
      data: {
        userId,
        provider,
        product: product || null,
        amount: amount || null,
        tag: tag || "other",
        currency: currency || null,
        startDate: startDate ? new Date(startDate) : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        nextBilling: nextBilling ? new Date(nextBilling) : null,
      },
    });

    res.status(201).json(newSub);
  } catch (error) {
    console.error("Create subscription error:", error);
    res.status(500).json({ error: "Failed to create subscription" });
  }
};

export const updateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Subscription ID required" });
    }

    // Verify user owns this subscription
    const subscription = await prisma.subscription.findUnique({
      where: { id },
    });

    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    if (subscription.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Validate update data
    const updates = req.body;
    if (
      updates.amount &&
      (typeof updates.amount !== "number" || updates.amount < 0)
    ) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const updated = await prisma.subscription.update({
      where: { id },
      data: updates,
    });

    res.json(updated);
  } catch (error) {
    console.error("Update subscription error:", error);
    res.status(500).json({ error: "Failed to update subscription" });
  }
};

export const deleteSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Subscription ID required" });
    }

    // Verify user owns this subscription
    const subscription = await prisma.subscription.findUnique({
      where: { id },
    });

    if (!subscription) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    if (subscription.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await prisma.subscription.delete({
      where: { id },
    });

    res.json({ message: "Subscription deleted successfully" });
  } catch (error) {
    console.error("Delete subscription error:", error);
    res.status(500).json({ error: "Failed to delete subscription" });
  }
};

import { EstimateGroupModel } from "../models/EstimateGroup.js";
import { TaskModel } from "../models/Task.js";
import { toIdString } from "./history.js";

function toMoney(value: number): number {
  return Number(Number(value ?? 0).toFixed(2));
}

export function buildEstimateGroupSnapshot(
  group: {
    name?: string;
    totalAmount?: number;
    entryTotalAmount?: number;
    entryCurrency?: string;
    usdToEntryRate?: number;
    exchangeRateDate?: Date | string | null;
    paymentEntries?: Array<{
      entryAmount?: number;
      amountUsd?: number;
      entryCurrency?: string;
      usdToEntryRate?: number;
      exchangeRateDate?: Date | string | null;
      recordedAt?: Date | string | null;
      expenseId?: unknown;
    }>;
    phase?: string;
    phaseTaskId?: unknown;
    section?: string;
    sectionTaskId?: unknown;
    taskIds?: unknown[];
  },
  tasks: Array<{ _id?: unknown; title?: string; estimateAmount?: number; budgetImpact?: number }> = []
) {
  const taskAllocations = tasks.map((task) => ({
    taskId: toIdString(task?._id),
    title: task?.title ?? "",
    estimateAmount: toMoney(Number(task?.estimateAmount ?? task?.budgetImpact ?? 0))
  }));
  const allocatedAmount = taskAllocations.reduce((sum, task) => sum + task.estimateAmount, 0);
  const paymentEntries = Array.isArray(group?.paymentEntries)
    ? group.paymentEntries.map((entry) => ({
        entryAmount: toMoney(Number(entry?.entryAmount ?? 0)),
        amountUsd: toMoney(Number(entry?.amountUsd ?? 0)),
        entryCurrency: entry?.entryCurrency ?? group?.entryCurrency ?? "USD",
        usdToEntryRate: toMoney(Number(entry?.usdToEntryRate ?? group?.usdToEntryRate ?? 1)),
        exchangeRateDate: entry?.exchangeRateDate ? new Date(entry.exchangeRateDate).toISOString() : "",
        recordedAt: entry?.recordedAt ? new Date(entry.recordedAt).toISOString() : "",
        expenseId: toIdString(entry?.expenseId)
      }))
    : [];
  const paidAmount = paymentEntries.reduce((sum, entry) => sum + entry.amountUsd, 0);
  const entryPaidAmount = paymentEntries.reduce((sum, entry) => sum + entry.entryAmount, 0);
  const totalAmount = toMoney(Number(group?.totalAmount ?? 0));

  return {
    name: group?.name ?? "",
    totalAmount,
    entryTotalAmount: toMoney(Number(group?.entryTotalAmount ?? group?.totalAmount ?? 0)),
    entryCurrency: group?.entryCurrency ?? "USD",
    usdToEntryRate: toMoney(Number(group?.usdToEntryRate ?? 1)),
    exchangeRateDate: group?.exchangeRateDate ? new Date(group.exchangeRateDate).toISOString() : "",
    phase: group?.phase ?? "",
    phaseTaskId: toIdString(group?.phaseTaskId),
    section: group?.section ?? "",
    sectionTaskId: toIdString(group?.sectionTaskId),
    taskIds: Array.isArray(group?.taskIds) ? group.taskIds.map((taskId) => toIdString(taskId)).filter(Boolean) : [],
    taskCount: taskAllocations.length,
    allocatedAmount: toMoney(allocatedAmount),
    unallocatedAmount: toMoney(totalAmount - allocatedAmount),
    paidAmount: toMoney(paidAmount),
    entryPaidAmount: toMoney(entryPaidAmount),
    remainingAmount: toMoney(Math.max(0, totalAmount - paidAmount)),
    entryRemainingAmount: toMoney(Math.max(0, Number(group?.entryTotalAmount ?? group?.totalAmount ?? 0) - entryPaidAmount)),
    paymentCount: paymentEntries.length,
    paymentEntries,
    taskAllocations
  };
}

export function toEstimateGroupResponse(group: {
  _id?: unknown;
  name?: string;
  totalAmount?: number;
  entryTotalAmount?: number;
  entryCurrency?: string;
  usdToEntryRate?: number;
  exchangeRateDate?: Date | string | null;
  paymentEntries?: Array<{
    entryAmount?: number;
    amountUsd?: number;
    entryCurrency?: string;
    usdToEntryRate?: number;
    exchangeRateDate?: Date | string | null;
    recordedAt?: Date | string | null;
    expenseId?: unknown;
  }>;
  phase?: string;
  phaseTaskId?: unknown;
  section?: string;
  sectionTaskId?: unknown;
  taskIds?: unknown[];
  createdAt?: Date | string;
  updatedAt?: Date | string;
}) {
  const paymentEntries = Array.isArray(group?.paymentEntries)
    ? group.paymentEntries.map((entry) => ({
        entryAmount: toMoney(Number(entry?.entryAmount ?? 0)),
        amountUsd: toMoney(Number(entry?.amountUsd ?? 0)),
        entryCurrency: entry?.entryCurrency ?? group?.entryCurrency ?? "USD",
        usdToEntryRate: toMoney(Number(entry?.usdToEntryRate ?? group?.usdToEntryRate ?? 1)),
        exchangeRateDate: entry?.exchangeRateDate ? new Date(entry.exchangeRateDate).toISOString() : "",
        recordedAt: entry?.recordedAt ? new Date(entry.recordedAt).toISOString() : "",
        expenseId: toIdString(entry?.expenseId)
      }))
    : [];
  const paidAmount = paymentEntries.reduce((sum, entry) => sum + entry.amountUsd, 0);
  const entryPaidAmount = paymentEntries.reduce((sum, entry) => sum + entry.entryAmount, 0);
  const totalAmount = toMoney(Number(group?.totalAmount ?? 0));
  const entryTotalAmount = toMoney(Number(group?.entryTotalAmount ?? group?.totalAmount ?? 0));

  return {
    _id: toIdString(group?._id),
    name: group?.name ?? "",
    totalAmount,
    entryTotalAmount,
    entryCurrency: group?.entryCurrency ?? "USD",
    usdToEntryRate: toMoney(Number(group?.usdToEntryRate ?? 1)),
    exchangeRateDate: group?.exchangeRateDate ? new Date(group.exchangeRateDate).toISOString() : "",
    phase: group?.phase ?? "",
    phaseTaskId: toIdString(group?.phaseTaskId),
    section: group?.section ?? "",
    sectionTaskId: toIdString(group?.sectionTaskId),
    taskIds: Array.isArray(group?.taskIds) ? group.taskIds.map((taskId) => toIdString(taskId)).filter(Boolean) : [],
    paidAmount: toMoney(paidAmount),
    entryPaidAmount: toMoney(entryPaidAmount),
    remainingAmount: toMoney(Math.max(0, totalAmount - paidAmount)),
    entryRemainingAmount: toMoney(Math.max(0, entryTotalAmount - entryPaidAmount)),
    paymentEntries,
    createdAt: group?.createdAt ? new Date(group.createdAt).toISOString() : "",
    updatedAt: group?.updatedAt ? new Date(group.updatedAt).toISOString() : ""
  };
}

export async function attachEstimateGroupToTasks(groupId: string, taskIds: string[]) {
  if (taskIds.length === 0) {
    return;
  }

  await TaskModel.updateMany(
    { _id: { $in: taskIds } },
    {
      $set: {
        estimateGroupId: groupId
      }
    }
  );
}

export async function clearEstimateGroupFromTasks(taskIds: string[]) {
  if (taskIds.length === 0) {
    return;
  }

  await TaskModel.updateMany(
    { _id: { $in: taskIds } },
    {
      $unset: {
        estimateGroupId: ""
      }
    }
  );
}

export async function detachTaskFromEstimateGroup(taskId: string) {
  const estimateGroup = await EstimateGroupModel.findOne({ taskIds: taskId });
  if (!estimateGroup) {
    return;
  }

  const nextTaskIds = estimateGroup.taskIds
    .map((entry) => toIdString(entry))
    .filter((entry) => entry && entry !== taskId);

  await TaskModel.updateOne(
    { _id: taskId },
    {
      $unset: {
        estimateGroupId: ""
      }
    }
  );

  if (nextTaskIds.length === 0) {
    await EstimateGroupModel.findByIdAndDelete(estimateGroup._id);
    return;
  }

  estimateGroup.taskIds = nextTaskIds as any;
  await estimateGroup.save();
}

export async function deleteEstimateGroupAndClearTasks(groupId: string) {
  const estimateGroup = await EstimateGroupModel.findById(groupId);
  if (!estimateGroup) {
    return null;
  }

  const taskIds = estimateGroup.taskIds.map((entry) => toIdString(entry)).filter(Boolean);
  await clearEstimateGroupFromTasks(taskIds);
  await EstimateGroupModel.findByIdAndDelete(groupId);
  return estimateGroup;
}

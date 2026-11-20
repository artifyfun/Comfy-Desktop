import { customAlphabet } from "nanoid";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const nanoid24 = customAlphabet(alphabet, 24);
export function newResponseId() {
    return `resp_${nanoid24()}`;
}
export function newMessageId() {
    return `msg_${nanoid24()}`;
}
export function newFunctionCallId() {
    return `fc_${nanoid24()}`;
}
export function newReasoningId() {
    return `rs_${nanoid24()}`;
}
export function newCallId() {
    return `call_${nanoid24()}`;
}
//# sourceMappingURL=ids.js.map
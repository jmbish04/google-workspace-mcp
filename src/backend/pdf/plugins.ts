/**
 * @file src/backend/pdf/plugins.ts
 * @description Bundled plugin map for pdfme generator and viewer.
 */
import {
  barcodes,
  checkbox,
  date,
  dateTime,
  ellipse,
  image,
  line,
  multiVariableText,
  radioGroup,
  rectangle,
  select,
  signature,
  svg,
  table,
  text,
  time,
} from "@pdfme/schemas";

export const defaultTableSchema = table.propPanel.defaultSchema;

export const pdfmePlugins = {
  text,
  image,
  table,
  multiVariableText,
  line,
  rectangle,
  ellipse,
  dateTime,
  date,
  time,
  select,
  radioGroup,
  checkbox,
  svg,
  signature,
  qrcode: barcodes.qrcode,
  code128: barcodes.code128,
  ean13: barcodes.ean13,
  pdf417: barcodes.pdf417,
};

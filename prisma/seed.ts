/**
 * Seed — TekSolv as tenant #1.
 *
 * The data is lifted from the validated prototype (docs/AssetHubDemo.jsx):
 * real FAM asset records, the real 21-truck fleet, real rental tickets and
 * their job sites. "Today" is pinned to the prototype's 2026-08-04 so the
 * demo reads identically: the same units overdue, the same compressor tipping
 * over its 500-hour service, the same truck showing a pulled SCBA.
 *
 * Idempotent: re-running upserts rather than duplicating.
 *
 * Note the explicit `orgId` on every create. The scoped client overrides it
 * anyway (see src/lib/tenant-db.ts) — Prisma's types require it, and naming it
 * keeps tenancy visible at each write.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import {
  type AssetStatus,
  type Condition,
  type LocationType,
  type MaintenanceType,
  type Role,
  type ScheduleBasis,
} from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { openSingleLineOrder } from '../src/lib/rental-orders'

const TODAY = new Date('2026-08-04T12:00:00Z')
const day = (iso: string) => new Date(`${iso}T12:00:00Z`)

// ---------------------------------------------------------------------------
// Reference data (prototype parity)
// ---------------------------------------------------------------------------

const ORG = { name: 'TekSolv', slug: 'teksolv' }

interface SeedUser {
  email: string
  name: string
  role: Role
  title?: string
  /** Location key for the office they work out of — the shelf their grabs draw from. */
  office?: string
}

/**
 * The roster. `office` is where each person works out of — supplies come off
 * that office's shelf when they grab. Tim is deliberately left without one, so
 * a fresh install exercises the "which office?" path the grab step falls back
 * to rather than only ever the happy one.
 */
const USERS: SeedUser[] = [
  { email: 'ray@teksolv.com', name: 'Ray B.', role: 'ADMIN', title: 'Operations owner', office: 'wh' },
  { email: 'sam@teksolv.com', name: 'Sam Okafor', role: 'MANAGER', title: 'Supervisor', office: 'wh' },
  { email: 'dreyes@teksolv.com', name: 'Dave Reyes', role: 'TECHNICIAN', title: 'Field technician', office: 'wh' },
  { email: 'malvarez@teksolv.com', name: 'Maria Alvarez', role: 'TECHNICIAN', title: 'Field technician', office: 'newark' },
  { email: 'jtucker@teksolv.com', name: 'Jon Tucker', role: 'TECHNICIAN', title: 'Field technician', office: 'oakdale' },
  { email: 'kpatel@teksolv.com', name: 'Kayla Patel', role: 'TECHNICIAN', title: 'Field technician', office: 'newark' },
  { email: 'bfinnegan@teksolv.com', name: 'Bucky Finnegan', role: 'TECHNICIAN', title: 'Rescue technician', office: 'oakdale' },
  { email: 'thopkins@teksolv.com', name: 'Tim Hopkins', role: 'TECHNICIAN', title: 'Rescue technician' },
  { email: 'gunterreiner@teksolv.com', name: 'Grant Unterreiner', role: 'TECHNICIAN', title: 'Rescue technician', office: 'wh' },
  { email: 'audit@teksolv.com', name: 'Pat Nguyen', role: 'VIEWER', title: 'Safety auditor', office: 'wh' },
]

/** Two-level category tree: parent slug then children. */
const CATEGORIES: { slug: string; name: string; parent?: string; hoursPerDay?: number }[] = [
  { slug: 'gas-detection', name: 'Gas Detection' },
  { slug: 'gas', name: 'Portable Monitors', parent: 'gas-detection' },
  { slug: 'single', name: 'Single-Gas', parent: 'gas-detection' },
  { slug: 'confined-space', name: 'Confined Space' },
  { slug: 'vent', name: 'Ventilation', parent: 'confined-space' },
  { slug: 'access', name: 'Access', parent: 'confined-space' },
  { slug: 'respiratory', name: 'Respiratory' },
  { slug: 'scba', name: 'SCBA', parent: 'respiratory' },
  { slug: 'sar', name: 'Supplied-Air (SAR)', parent: 'respiratory' },
  { slug: 'breathing-air', name: 'Breathing Air' },
  { slug: 'air', name: 'Compressors', parent: 'breathing-air', hoursPerDay: 8 },
  { slug: 'fall-protection', name: 'Fall Protection' },
  { slug: 'fall', name: 'Lifelines', parent: 'fall-protection' },
]

const LOCATIONS: { key: string; name: string; type: LocationType }[] = [
  { key: 'wh', name: 'New Castle Warehouse', type: 'WAREHOUSE' },
  { key: 'newark', name: 'Newark Office', type: 'OFFICE' },
  { key: 'oakdale', name: 'Oakdale Office', type: 'OFFICE' },
  { key: 'collinsville', name: 'Collinsville Office', type: 'OFFICE' },
  { key: 'bay', name: 'Service Bay', type: 'SERVICE_BAY' },
  { key: 'jobA', name: 'Marcellus Pad 7', type: 'JOBSITE' },
  { key: 'jobB', name: 'Greene Co. Compressor', type: 'JOBSITE' },
  { key: 'jobC', name: 'Washington Co. Turnaround', type: 'JOBSITE' },
]

/** The real fleet. 165/166/167 permanently belong to a named tech. */
const TRUCKS: { number: string; office: string; ownerEmail?: string }[] = [
  { number: '128', office: 'Collinsville' },
  { number: '135', office: 'Oakdale' },
  { number: '136', office: 'Newark' },
  { number: '137', office: 'Newark' },
  { number: '138', office: 'Newark' },
  { number: '140', office: 'Collinsville' },
  { number: '144', office: 'Newark' },
  { number: '146', office: 'Newark' },
  { number: '148', office: 'Newark' },
  { number: '152', office: 'Newark' },
  { number: '153', office: 'Newark' },
  { number: '154', office: 'Newark' },
  { number: '155', office: 'Newark' },
  { number: '156', office: 'Newark' },
  { number: '157', office: 'Newark' },
  { number: '158', office: 'Oakdale' },
  { number: '160', office: 'Newark' },
  { number: '161', office: 'Collinsville' },
  { number: '165', office: 'Newark', ownerEmail: 'bfinnegan@teksolv.com' },
  { number: '166', office: 'Newark', ownerEmail: 'thopkins@teksolv.com' },
  { number: '167', office: 'Newark', ownerEmail: 'gunterreiner@teksolv.com' },
]

/**
 * Supplies, and where each office keeps them.
 *
 * Stock is per office, so the fixture is too — a single fleet-wide number would
 * seed a shape the app no longer has. Cal gas and filters are lot-tracked: they
 * come in dated batches and an out-of-date one must not be issued. Gloves and
 * glasses are a number on a shelf.
 */
const CONSUMABLES: {
  name: string
  unit: string
  lotTracked?: boolean
  expiryLeadDays?: number
  /** Calibration gas only — pre-fills Form CAL-01's gas table. */
  gasComponents?: { gas: string; amount: string; unit: 'PPM' | 'PERCENT_VOL' | 'PERCENT_LEL' }[]
  concentration?: string
  /** office name → what that office holds, and the line it reorders at. */
  stock: Record<string, { onHand: number; reorderPoint: number }>
}[] = [
  {
    name: 'Safety glasses',
    unit: 'pair',
    stock: {
      'New Castle Warehouse': { onHand: 48, reorderPoint: 20 },
      'Newark Office': { onHand: 12, reorderPoint: 6 },
      'Oakdale Office': { onHand: 9, reorderPoint: 6 },
    },
  },
  {
    name: 'Nitrile gloves (box)',
    unit: 'box',
    stock: {
      'New Castle Warehouse': { onHand: 22, reorderPoint: 10 },
      'Newark Office': { onHand: 6, reorderPoint: 4 },
      'Oakdale Office': { onHand: 5, reorderPoint: 4 },
    },
  },
  {
    name: 'H2S cal gas (34L)',
    unit: 'cylinder',
    lotTracked: true,
    expiryLeadDays: 45,
    // What is in the cylinder, so a technician picking this lot on the log
    // service form gets CAL-01's gas row filled in rather than retyping it.
    // A single-gas cylinder is a one-component list.
    gasComponents: [{ gas: 'H2S', amount: '25', unit: 'PPM' }],
    stock: {
      'New Castle Warehouse': { onHand: 6, reorderPoint: 4 },
      'Oakdale Office': { onHand: 3, reorderPoint: 2 },
    },
  },
  {
    name: 'P100 filters (pair)',
    unit: 'pair',
    lotTracked: true,
    expiryLeadDays: 30,
    stock: {
      'New Castle Warehouse': { onHand: 15, reorderPoint: 8 },
      'Newark Office': { onHand: 4, reorderPoint: 4 },
    },
  },
]

const CUSTOMERS: { name: string; contact: string | null; internal?: boolean }[] = [
  { name: 'Infinity Resources', contact: 'Tom Beck' },
  { name: 'EQT', contact: null },
  { name: 'Range Resources', contact: 'Dana Pruitt' },
  { name: 'Corrado American, LLC', contact: 'Richard Civita' },
  { name: 'TekSolv (internal)', contact: null, internal: true },
]

const JOBS = [
  { name: 'Marcellus Pad 7', customer: 'Infinity Resources' },
  { name: 'Greene Co. Compressor', customer: 'EQT' },
  { name: 'Washington Co. Turnaround', customer: 'Range Resources' },
  { name: 'Customer pickup - credit card', customer: 'Corrado American, LLC' },
]

/**
 * Admin-defined typed fields, attached at a category and inherited by its
 * children. Values live in Asset.customFields, so adding a field never means
 * migrating the schema.
 */
const FIELD_DEFS: {
  categorySlug: string | null
  key: string
  label: string
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT'
  options?: string[]
  required?: boolean
  order: number
}[] = [
  {
    categorySlug: 'gas-detection',
    key: 'sensorSet',
    label: 'Sensor set',
    type: 'SELECT',
    options: ['4-gas (LEL/O2/CO/H2S)', '5-gas (+ VOC)', 'H2S only', 'LEL only'],
    order: 0,
  },
  {
    categorySlug: 'gas-detection',
    key: 'pumped',
    label: 'Pumped',
    type: 'BOOLEAN',
    order: 1,
  },
  {
    categorySlug: 'respiratory',
    key: 'facepieceSize',
    label: 'Facepiece size',
    type: 'SELECT',
    options: ['Small', 'Medium', 'Large'],
    order: 0,
  },
  {
    categorySlug: 'fall-protection',
    key: 'capacityLb',
    label: 'Capacity (lb)',
    type: 'NUMBER',
    order: 0,
  },
]

/** Inspection templates by equipment category. `crit` = fail takes it OOS. */
const TEMPLATES: {
  slug: string
  name: string
  categorySlug: string[]
  responseType: 'PASS_FAIL' | 'YES_NO_NA'
  items: { label: string; crit: boolean }[]
}[] = [
  {
    slug: 'gas-monitor-bump-test',
    name: 'Gas Monitor Pre-Use / Bump Test',
    categorySlug: ['gas', 'single'],
    responseType: 'PASS_FAIL',
    items: [
      { label: 'Housing, display & keypad intact', crit: true },
      { label: 'Battery charged', crit: true },
      { label: 'Sensors respond to test gas (bump)', crit: true },
      { label: 'Audible & visual alarms activate', crit: true },
      { label: 'Calibration within date', crit: true },
      { label: 'Pump / flow OK (if pumped)', crit: false },
    ],
  },
  {
    slug: 'scba-sar-inspection',
    name: 'SCBA / SAR Inspection',
    categorySlug: ['scba', 'sar'],
    responseType: 'YES_NO_NA',
    items: [
      { label: 'Cylinder pressure full', crit: true },
      { label: 'Hydrostatic test within date', crit: true },
      { label: 'Regulator & low-air alarm function', crit: true },
      { label: 'Facepiece seal & lens intact', crit: true },
      { label: 'Harness & straps undamaged', crit: true },
      { label: 'Supply hoses / fittings intact (SAR)', crit: false },
    ],
  },
  {
    slug: 'confined-space-equipment',
    name: 'Confined Space Equipment',
    categorySlug: ['access', 'vent'],
    responseType: 'PASS_FAIL',
    items: [
      { label: 'Tripod legs, pins & chains intact', crit: true },
      { label: 'Winch cable free of frays / kinks', crit: true },
      { label: 'Winch brake & clutch hold load', crit: true },
      { label: 'Blower runs, ducting intact', crit: false },
      { label: 'Labels & load rating legible', crit: false },
    ],
  },
  {
    slug: 'fall-protection-inspection',
    name: 'Fall Protection Inspection',
    categorySlug: ['fall'],
    responseType: 'PASS_FAIL',
    items: [
      { label: 'Webbing free of cuts / burns / fray', crit: true },
      { label: 'Stitching intact', crit: true },
      { label: 'D-rings & hardware undamaged', crit: true },
      { label: 'SRL retracts & locks', crit: true },
      { label: 'Impact indicator not deployed', crit: true },
      { label: 'Labels legible & within date', crit: false },
    ],
  },
  {
    slug: 'breathing-air-compressor',
    name: 'Breathing Air Compressor',
    categorySlug: ['air'],
    responseType: 'PASS_FAIL',
    items: [
      { label: 'Air-quality filters current', crit: true },
      { label: 'CO monitor functions', crit: true },
      { label: 'Hoses & fittings intact', crit: true },
      { label: 'Oil level OK (if applicable)', crit: false },
    ],
  },
]

interface SeedSchedule {
  label: string
  type: MaintenanceType
  basis: ScheduleBasis
  intervalDays?: number
  intervalUsage?: number
  hoursPerDay?: number
  priorUsage?: number
  lastPerformed?: string
  nextDue?: string
}

interface SeedRentalHistory {
  customer: string
  job: string
  out: string
  due: string
  by: string
  returned: string
}

interface SeedOpenRental {
  orderNumber?: string
  customer: string
  contact?: string
  job: string
  out: string
  due: string
  by: string | null // null = counter pickup
}

interface SeedAsset {
  tag: string
  model: string
  manufacturer: string
  serial: string | null
  category: string
  status: AssetStatus
  condition: Condition
  location: string
  cost: number
  rate: number
  notes?: string
  custom?: Record<string, unknown>
  custody?: { type: 'PERSON'; email: string } | { type: 'TRUCK'; number: string }
  schedules?: SeedSchedule[]
  history?: SeedRentalHistory[]
  open?: SeedOpenRental
}

const ASSETS: SeedAsset[] = [
  {
    tag: 'FAM001006',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '4095',
    category: 'gas',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 1850,
    rate: 45,
    custom: { sensorSet: '4-gas (LEL/O2/CO/H2S)', pumped: false },
    schedules: [
      { label: 'Calibration', type: 'CALIBRATION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-09-02' },
    ],
    history: [
      { customer: 'Range Resources', job: 'Washington Co. Turnaround', out: '2026-05-02', due: '2026-05-30', by: 'malvarez@teksolv.com', returned: '2026-05-28' },
      { customer: 'EQT', job: 'Greene Co. Compressor', out: '2026-03-10', due: '2026-04-07', by: 'dreyes@teksolv.com', returned: '2026-04-05' },
    ],
  },
  {
    tag: 'FAM001007',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '8195',
    category: 'gas',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobA',
    cost: 1850,
    rate: 45,
    open: { orderNumber: 'SO25418', customer: 'Infinity Resources', contact: 'Tom Beck', job: 'Marcellus Pad 7', out: '2026-07-21', due: '2026-08-11', by: 'dreyes@teksolv.com' },
  },
  {
    tag: 'FAM001008',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '8207',
    category: 'gas',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobA',
    cost: 1850,
    rate: 45,
    open: { customer: 'Infinity Resources', job: 'Marcellus Pad 7', out: '2026-07-21', due: '2026-08-11', by: 'dreyes@teksolv.com' },
  },
  {
    tag: 'FAM001009',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '8230',
    category: 'gas',
    status: 'IN_MAINTENANCE',
    condition: 'FAIR',
    location: 'bay',
    cost: 1850,
    rate: 45,
    notes: 'Calibration in progress - O2 sensor drift.',
  },
  {
    tag: 'FAM001010',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '8254',
    category: 'gas',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'newark',
    cost: 1850,
    rate: 45,
    custody: { type: 'PERSON', email: 'dreyes@teksolv.com' },
    schedules: [
      { label: 'Calibration', type: 'CALIBRATION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-08-08' },
    ],
  },
  {
    tag: 'FAM001011',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '29406',
    category: 'gas',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobC',
    cost: 1850,
    rate: 45,
    // Due back 2026-07-30 - overdue as of the pinned "today".
    open: { orderNumber: 'SO25390', customer: 'Range Resources', contact: 'Dana Pruitt', job: 'Washington Co. Turnaround', out: '2026-07-05', due: '2026-07-30', by: 'malvarez@teksolv.com' },
  },
  {
    tag: 'FAM001012',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '22478',
    category: 'gas',
    status: 'OUT_OF_SERVICE',
    condition: 'POOR',
    location: 'bay',
    cost: 1850,
    rate: 45,
    notes: 'Failed bump test - H2S sensor unresponsive. Ticket open.',
  },
  {
    tag: 'FAM001013',
    model: '4 Gas Atmospheric Monitor',
    manufacturer: 'MSA',
    serial: '22837',
    category: 'gas',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 1850,
    rate: 45,
    custody: { type: 'PERSON', email: 'malvarez@teksolv.com' },
    schedules: [
      { label: 'Calibration', type: 'CALIBRATION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-10-14' },
    ],
  },
  {
    tag: 'FAM001020',
    model: 'G7c Connected Single-Gas H2S',
    manufacturer: 'Blackline Safety',
    serial: 'G7C-77120',
    category: 'single',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobB',
    cost: 1200,
    rate: 38,
    open: { customer: 'EQT', job: 'Greene Co. Compressor', out: '2026-07-28', due: '2026-08-18', by: 'malvarez@teksolv.com' },
  },
  {
    tag: 'FAM001021',
    model: 'G7c Connected Single-Gas H2S',
    manufacturer: 'Blackline Safety',
    serial: 'G7C-77134',
    category: 'single',
    status: 'AVAILABLE',
    condition: 'NEW',
    location: 'newark',
    cost: 1200,
    rate: 38,
    custody: { type: 'TRUCK', number: '136' },
    schedules: [
      { label: 'Calibration', type: 'CALIBRATION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-11-01' },
    ],
  },
  {
    tag: 'FAM001030',
    model: 'MultiRAE Lite Pumped',
    manufacturer: 'RAE Systems',
    serial: 'M02-591183',
    category: 'gas',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 2400,
    rate: 55,
    custom: { sensorSet: '5-gas (+ VOC)', pumped: true },
    custody: { type: 'PERSON', email: 'jtucker@teksolv.com' },
    schedules: [
      { label: 'Calibration', type: 'CALIBRATION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-08-09' },
    ],
  },
  {
    tag: 'FAM002001',
    model: 'Confined Space Blower 8in',
    manufacturer: 'Air Systems',
    serial: 'SVB-8-2231',
    category: 'vent',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobB',
    cost: 650,
    rate: 30,
    open: { customer: 'EQT', job: 'Greene Co. Compressor', out: '2026-07-28', due: '2026-08-18', by: 'malvarez@teksolv.com' },
  },
  {
    tag: 'FAM002002',
    model: 'Entry Tripod + Winch',
    manufacturer: 'DBI-SALA',
    serial: 'TR-4409',
    category: 'access',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'collinsville',
    cost: 1400,
    rate: 40,
    custody: { type: 'TRUCK', number: '128' },
    schedules: [
      { label: 'Periodic inspection', type: 'INSPECTION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-08-06' },
    ],
  },
  {
    tag: 'FAM002003',
    model: 'Entry Tripod + Winch',
    manufacturer: 'DBI-SALA',
    serial: 'TR-4410',
    category: 'access',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobC',
    cost: 1400,
    rate: 40,
    open: { customer: 'Range Resources', job: 'Washington Co. Turnaround', out: '2026-07-05', due: '2026-08-15', by: 'malvarez@teksolv.com' },
  },
  {
    tag: 'FAM003001',
    model: 'G1 SCBA 4500 psi',
    manufacturer: 'MSA',
    serial: 'G1-118842',
    category: 'scba',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'newark',
    cost: 3900,
    rate: 75,
    custom: { facepieceSize: 'Medium' },
    custody: { type: 'TRUCK', number: '165' },
    schedules: [
      { label: 'Annual flow test', type: 'PREVENTIVE', basis: 'CALENDAR', intervalDays: 365, lastPerformed: '2025-08-20' },
      { label: '5-yr cylinder hydrostatic', type: 'HYDROSTATIC', basis: 'CALENDAR', intervalDays: 1825, lastPerformed: '2023-01-10' },
    ],
  },
  {
    // Staged on Truck 165 but pulled for a hydro test - this is what makes the
    // readiness panel show "Check" instead of "Ready".
    tag: 'FAM003002',
    model: 'G1 SCBA 4500 psi',
    manufacturer: 'MSA',
    serial: 'G1-118844',
    category: 'scba',
    status: 'IN_MAINTENANCE',
    condition: 'FAIR',
    location: 'bay',
    cost: 3900,
    rate: 75,
    notes: 'Annual hydrostatic test on cylinder - pulled from Truck 165.',
    custody: { type: 'TRUCK', number: '165' },
  },
  {
    tag: 'FAM004001',
    model: "Self-Retracting Lifeline 30'",
    manufacturer: 'DBI-SALA',
    serial: 'SRL-9931',
    category: 'fall',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'jobA',
    cost: 520,
    rate: 22,
    open: { customer: 'Infinity Resources', job: 'Marcellus Pad 7', out: '2026-07-21', due: '2026-08-11', by: 'dreyes@teksolv.com' },
  },
  {
    tag: 'FAM004002',
    model: "Self-Retracting Lifeline 30'",
    manufacturer: 'DBI-SALA',
    serial: 'SRL-9932',
    category: 'fall',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'collinsville',
    cost: 520,
    rate: 22,
    custody: { type: 'TRUCK', number: '128' },
    schedules: [
      { label: 'Periodic inspection', type: 'INSPECTION', basis: 'CALENDAR', intervalDays: 180, nextDue: '2026-08-01' },
    ],
  },
  {
    tag: 'FAM004003',
    model: 'Full-Body Harness',
    manufacturer: 'Miller',
    serial: 'HB-20714',
    category: 'fall',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 180,
    rate: 12,
    custom: { capacityLb: 420 },
  },
  {
    tag: 'FAM011957',
    model: '5-Piece Davit Hoist System',
    manufacturer: 'DBI-SALA',
    serial: null,
    category: 'access',
    status: 'OUT_ON_RENT',
    condition: 'GOOD',
    location: 'wh',
    cost: 5719,
    rate: 110,
    // Counter pickup, credit card, no tech involved.
    open: { orderNumber: 'SO25472', customer: 'Corrado American, LLC', contact: 'Richard Civita', job: 'Customer pickup - credit card', out: '2026-08-04', due: '2026-08-14', by: null },
  },
  {
    tag: 'FAM005001',
    model: 'TA-3 Breathing Air Compressor',
    manufacturer: 'Air Systems',
    serial: 'TA3-1188',
    category: 'air',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'newark',
    cost: 4200,
    rate: 90,
    custody: { type: 'TRUCK', number: '136' },
    // 456 banked + 7 rental days x 8 = 512 estimated hours -> service due.
    schedules: [
      { label: '500-hour service (in-house)', type: 'PREVENTIVE', basis: 'USAGE', intervalUsage: 500, hoursPerDay: 8, priorUsage: 456 },
    ],
    history: [
      { customer: 'EQT', job: 'Greene Co. Compressor', out: '2026-06-01', due: '2026-06-10', by: 'malvarez@teksolv.com', returned: '2026-06-08' },
    ],
  },
  {
    tag: 'FAM005002',
    model: 'TA-3 Breathing Air Compressor',
    manufacturer: 'Air Systems',
    serial: 'TA3-1190',
    category: 'air',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 4200,
    rate: 90,
    // 400 banked + 4 rental days x 8 = 432 of 500 -> "due soon".
    schedules: [
      { label: '500-hour service (in-house)', type: 'PREVENTIVE', basis: 'USAGE', intervalUsage: 500, hoursPerDay: 8, priorUsage: 400 },
    ],
    history: [
      { customer: 'Infinity Resources', job: 'Marcellus Pad 7', out: '2026-06-20', due: '2026-06-28', by: 'dreyes@teksolv.com', returned: '2026-06-24' },
    ],
  },
  {
    tag: 'FAM006001',
    model: 'Saturn Supplied-Air Respirator',
    manufacturer: 'Air Systems',
    serial: 'SAR-2207',
    category: 'sar',
    status: 'AVAILABLE',
    condition: 'GOOD',
    location: 'wh',
    cost: 1100,
    rate: 28,
    schedules: [
      { label: 'Annual flow test', type: 'PREVENTIVE', basis: 'CALENDAR', intervalDays: 365, lastPerformed: '2025-07-20' },
      { label: '5-yr cylinder hydrostatic', type: 'HYDROSTATIC', basis: 'CALENDAR', intervalDays: 1825, lastPerformed: '2022-03-01' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.')
  }

  const password = process.env.SEED_PASSWORD || 'assethub-dev'
  const passwordHash = await bcrypt.hash(password, 10)

  // --- Organization -------------------------------------------------------
  const org = await prismaUnscoped.organization.upsert({
    where: { slug: ORG.slug },
    update: { name: ORG.name },
    create: {
      name: ORG.name,
      slug: ORG.slug,
      settings: { offices: ['Newark', 'Oakdale', 'Collinsville'], defaultHoursPerDay: 8 },
    },
  })
  const db = dbForOrg(org.id)
  console.log(`Organization: ${org.name} (${org.id})`)

  // --- Users + memberships ------------------------------------------------
  const userIdByEmail = new Map<string, string>()
  for (const seed of USERS) {
    const user = await prismaUnscoped.user.upsert({
      where: { email: seed.email },
      update: { name: seed.name, passwordHash },
      create: { email: seed.email, name: seed.name, passwordHash },
    })
    userIdByEmail.set(seed.email, user.id)
    await prismaUnscoped.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      update: { role: seed.role, title: seed.title },
      create: { orgId: org.id, userId: user.id, role: seed.role, title: seed.title },
    })
  }
  const uid = (email: string) => {
    const id = userIdByEmail.get(email)
    if (!id) throw new Error(`Seed user not found: ${email}`)
    return id
  }
  console.log(`Users: ${USERS.length} with memberships`)

  // --- Categories (parents first) ----------------------------------------
  const categoryIdBySlug = new Map<string, string>()
  for (const category of CATEGORIES) {
    const parentId = category.parent ? categoryIdBySlug.get(category.parent) : undefined
    const row = await db.category.upsert({
      where: { orgId_slug: { orgId: org.id, slug: category.slug } },
      update: { name: category.name, parentId, hoursPerDay: category.hoursPerDay },
      create: {
        orgId: org.id,
        slug: category.slug,
        name: category.name,
        parentId,
        hoursPerDay: category.hoursPerDay,
      },
    })
    categoryIdBySlug.set(category.slug, row.id)
  }

  // --- Custom field definitions ------------------------------------------
  for (const definition of FIELD_DEFS) {
    const categoryId = definition.categorySlug
      ? (categoryIdBySlug.get(definition.categorySlug) ?? null)
      : null
    // Not an upsert: the unique is (orgId, categoryId, key) and categoryId is
    // nullable, so Postgres treats two global definitions as distinct rows and
    // Prisma's compound-unique input rejects a null anyway.
    const shared = {
      label: definition.label,
      type: definition.type,
      options: definition.options ?? undefined,
      required: definition.required ?? false,
      order: definition.order,
    }
    const existing = await db.customFieldDefinition.findFirst({
      where: { categoryId, key: definition.key },
    })
    if (existing) {
      await db.customFieldDefinition.update({ where: { id: existing.id }, data: shared })
    } else {
      await db.customFieldDefinition.create({
        data: { orgId: org.id, categoryId, key: definition.key, ...shared },
      })
    }
  }

  // --- Locations ----------------------------------------------------------
  const locationIdByKey = new Map<string, string>()
  for (const location of LOCATIONS) {
    const row = await db.location.upsert({
      where: { orgId_name: { orgId: org.id, name: location.name } },
      update: { type: location.type },
      create: { orgId: org.id, name: location.name, type: location.type },
    })
    locationIdByKey.set(location.key, row.id)
  }

  // --- Home offices -------------------------------------------------------
  // Set after locations exist, because that is when there is an office to point
  // at. A worker with none is a supported state, not a broken one — the grab
  // step asks them.
  let homed = 0
  for (const seed of USERS) {
    if (!seed.office) continue
    const locationId = locationIdByKey.get(seed.office)
    if (!locationId) continue
    await prismaUnscoped.membership.updateMany({
      where: { orgId: org.id, userId: uid(seed.email) },
      data: { homeLocationId: locationId },
    })
    homed++
  }
  console.log(`Home offices: ${homed} of ${USERS.length}`)

  // --- Trucks -------------------------------------------------------------
  const truckIdByNumber = new Map<string, string>()
  for (const truck of TRUCKS) {
    const ownerUserId = truck.ownerEmail ? uid(truck.ownerEmail) : null
    const row = await db.truck.upsert({
      where: { orgId_number: { orgId: org.id, number: truck.number } },
      update: { office: truck.office, ownerUserId },
      create: { orgId: org.id, number: truck.number, office: truck.office, ownerUserId },
    })
    truckIdByNumber.set(truck.number, row.id)
  }
  console.log(`Trucks: ${TRUCKS.length}`)

  // --- Consumables --------------------------------------------------------
  //
  // The item carries no count — stock is per office in ConsumableStock, and for
  // a lot-tracked item it is the sum of dated lots underneath that. Seeding
  // lots gives the fleet one batch comfortably in date and, for cal gas, one
  // close to expiry, so the expiry warning has something real to fire on the
  // first time anybody looks.
  const DAY = 86_400_000
  const OFFICE_KEY: Record<string, string> = Object.fromEntries(
    LOCATIONS.map((location) => [location.name, location.key]),
  )
  for (const consumable of CONSUMABLES) {
    const item = await db.consumable.upsert({
      where: { orgId_name: { orgId: org.id, name: consumable.name } },
      update: {
        unit: consumable.unit,
        lotTracked: consumable.lotTracked ?? false,
        expiryLeadDays: consumable.expiryLeadDays ?? 30,
      },
      create: {
        orgId: org.id,
        name: consumable.name,
        unit: consumable.unit,
        lotTracked: consumable.lotTracked ?? false,
        expiryLeadDays: consumable.expiryLeadDays ?? 30,
      },
    })

    // Components are replaced wholesale — the seed is the source of truth for
    // what a demo cylinder contains, and diffing rows it does not own would
    // leave a stale gas behind on a re-seed.
    await db.gasComponent.deleteMany({ where: { consumableId: item.id } })
    if (consumable.gasComponents?.length) {
      await db.gasComponent.createMany({
        data: consumable.gasComponents.map((component, position) => ({
          orgId: org.id,
          consumableId: item.id,
          gas: component.gas,
          amount: component.amount,
          unit: component.unit,
          position,
        })),
      })
    }

    for (const [officeName, held] of Object.entries(consumable.stock)) {
      const locationId = locationIdByKey.get(OFFICE_KEY[officeName])
      if (!locationId) continue

      await db.consumableStock.upsert({
        where: {
          orgId_consumableId_locationId: { orgId: org.id, consumableId: item.id, locationId },
        },
        update: { onHand: held.onHand, reorderPoint: held.reorderPoint },
        create: {
          orgId: org.id,
          consumableId: item.id,
          locationId,
          onHand: held.onHand,
          reorderPoint: held.reorderPoint,
        },
      })

      if (!consumable.lotTracked) continue

      // Two lots, split so the soonest-expiring one is the smaller: FEFO then
      // has something to demonstrate rather than draining one batch forever.
      const soonQty = Math.max(1, Math.floor(held.onHand / 3))
      const lots = [
        { lotNumber: `${item.id.slice(-4).toUpperCase()}-A`, quantity: soonQty, days: 40 },
        {
          lotNumber: `${item.id.slice(-4).toUpperCase()}-B`,
          quantity: held.onHand - soonQty,
          days: 400,
        },
      ]
      for (const lot of lots) {
        if (lot.quantity <= 0) continue
        await db.consumableLot.upsert({
          where: {
            orgId_consumableId_locationId_lotNumber: {
              orgId: org.id,
              consumableId: item.id,
              locationId,
              lotNumber: lot.lotNumber,
            },
          },
          update: {
            quantity: lot.quantity,
            expiresAt: new Date(Date.now() + lot.days * DAY),
          },
          create: {
            orgId: org.id,
            consumableId: item.id,
            locationId,
            lotNumber: lot.lotNumber,
            quantity: lot.quantity,
            expiresAt: new Date(Date.now() + lot.days * DAY),
          },
        })
      }
    }
  }

  // --- Customers + jobs ---------------------------------------------------
  const customerIdByName = new Map<string, string>()
  for (const customer of CUSTOMERS) {
    const existing = await db.customer.findFirst({ where: { name: customer.name } })
    const row = existing
      ? await db.customer.update({
          where: { id: existing.id },
          data: { contact: customer.contact, internal: customer.internal ?? false },
        })
      : await db.customer.create({
          data: {
            orgId: org.id,
            name: customer.name,
            contact: customer.contact,
            internal: customer.internal ?? false,
          },
        })
    customerIdByName.set(customer.name, row.id)
  }

  const jobIdByName = new Map<string, string>()
  for (const job of JOBS) {
    const existing = await db.job.findFirst({ where: { name: job.name } })
    const row =
      existing ??
      (await db.job.create({
        data: {
          orgId: org.id,
          name: job.name,
          customerId: customerIdByName.get(job.customer) ?? null,
        },
      }))
    jobIdByName.set(job.name, row.id)
  }

  // --- Inspection templates ----------------------------------------------
  for (const template of TEMPLATES) {
    const categoryId = categoryIdBySlug.get(template.categorySlug[0]) ?? null
    const row = await db.inspectionTemplate.upsert({
      where: { orgId_slug: { orgId: org.id, slug: template.slug } },
      update: { name: template.name, categoryId },
      create: { orgId: org.id, slug: template.slug, name: template.name, categoryId },
    })
    // Replace items wholesale so re-seeding tracks edits to this file.
    await db.inspectionTemplateItem.deleteMany({ where: { templateId: row.id } })
    await db.inspectionTemplateItem.createMany({
      data: template.items.map((item, index) => ({
        orgId: org.id,
        templateId: row.id,
        label: item.label,
        responseType: template.responseType,
        order: index,
        failCreatesTicket: item.crit,
      })),
    })
  }
  console.log(`Inspection templates: ${TEMPLATES.length}`)

  // --- Assets -------------------------------------------------------------
  const adminId = uid('ray@teksolv.com')
  let openRentals = 0
  let historyRentals = 0

  for (const seed of ASSETS) {
    const categoryId = categoryIdBySlug.get(seed.category)
    if (!categoryId) throw new Error(`Unknown category ${seed.category} for ${seed.tag}`)

    const custody =
      seed.custody?.type === 'PERSON'
        ? {
            custodyType: 'PERSON' as const,
            custodyUserId: uid(seed.custody.email),
            custodyTruckId: null,
            custodyAssignedById: adminId,
            custodyAssignedAt: TODAY,
          }
        : seed.custody?.type === 'TRUCK'
          ? {
              custodyType: 'TRUCK' as const,
              custodyUserId: null,
              custodyTruckId: truckIdByNumber.get(seed.custody.number) ?? null,
              custodyAssignedById: adminId,
              custodyAssignedAt: TODAY,
            }
          : {
              custodyType: null,
              custodyUserId: null,
              custodyTruckId: null,
              custodyAssignedById: null,
              custodyAssignedAt: null,
            }

    const core = {
      model: seed.model,
      manufacturer: seed.manufacturer,
      serialNumber: seed.serial,
      categoryId,
      status: seed.status,
      condition: seed.condition,
      locationId: locationIdByKey.get(seed.location) ?? null,
      purchaseCost: seed.cost,
      replacementCost: seed.cost,
      dailyRate: seed.rate,
      notes: seed.notes ?? null,
      customFields: seed.custom ?? {},
      ...custody,
    }

    const asset = await db.asset.upsert({
      where: { orgId_assetTag: { orgId: org.id, assetTag: seed.tag } },
      update: core,
      create: { orgId: org.id, assetTag: seed.tag, ...core },
    })

    if (seed.custody) {
      const already = await db.custodyEvent.findFirst({ where: { assetId: asset.id } })
      if (!already) {
        await db.custodyEvent.create({
          data: {
            orgId: org.id,
            assetId: asset.id,
            type: custody.custodyType,
            userId: custody.custodyUserId,
            truckId: custody.custodyTruckId,
            actorId: adminId,
            note: 'Seeded from the validated prototype.',
          },
        })
      }
    }

    // --- Maintenance schedules -------------------------------------------
    await db.maintenanceSchedule.deleteMany({ where: { assetId: asset.id } })
    for (const schedule of seed.schedules ?? []) {
      const lastPerformed = schedule.lastPerformed ? day(schedule.lastPerformed) : null
      const nextDue =
        schedule.nextDue != null
          ? day(schedule.nextDue)
          : lastPerformed && schedule.intervalDays
            ? new Date(lastPerformed.getTime() + schedule.intervalDays * 86_400_000)
            : null

      await db.maintenanceSchedule.create({
        data: {
          orgId: org.id,
          assetId: asset.id,
          label: schedule.label,
          type: schedule.type,
          basis: schedule.basis,
          intervalDays: schedule.intervalDays ?? null,
          intervalUsage: schedule.intervalUsage ?? null,
          hoursPerDay: schedule.hoursPerDay ?? null,
          priorUsage: schedule.priorUsage ?? 0,
          // Rental days are counted forward from here when estimating usage.
          usageAnchorAt: schedule.basis === 'USAGE' ? day('2026-01-01') : null,
          lastPerformed,
          nextDue,
        },
      })
    }

    // --- Rental history (closed) -----------------------------------------
    await db.rental.deleteMany({ where: { assetId: asset.id } })
    for (const past of seed.history ?? []) {
      // Each historical rental is its own closed one-line order, which is what
      // the migration made of every rental that already existed.
      const orderId = await openSingleLineOrder(db, {
        orgId: org.id,
        customerId: customerIdByName.get(past.customer) ?? null,
        jobId: jobIdByName.get(past.job) ?? null,
        recordedById: uid(past.by),
        checkedOutById: uid(past.by),
        checkoutDate: day(past.out),
        expectedReturnDate: day(past.due),
        closedAt: day(past.returned),
      })
      await db.rental.create({
        data: {
          orgId: org.id,
          orderId,
          assetId: asset.id,
          customerId: customerIdByName.get(past.customer) ?? null,
          jobId: jobIdByName.get(past.job) ?? null,
          recordedById: uid(past.by),
          checkedOutById: uid(past.by),
          checkedInById: uid(past.by),
          checkoutDate: day(past.out),
          expectedReturnDate: day(past.due),
          actualReturnDate: day(past.returned),
          checkoutCondition: 'GOOD',
          checkinCondition: 'GOOD',
          status: 'RETURNED',
        },
      })
      historyRentals++
    }

    // --- Open rental ------------------------------------------------------
    if (seed.open) {
      const open = seed.open
      const counterPickup = open.by === null

      // Create + reserve in ONE transaction: the deferred trigger
      // `rental_period_required` refuses to commit an open rental with no
      // reservation window. Same shape the Phase 3 checkout action will use.
      await db.$transaction(async (tx) => {
        const orderId = await openSingleLineOrder(tx, {
          orgId: org.id,
          customerId: customerIdByName.get(open.customer) ?? null,
          jobId: jobIdByName.get(open.job) ?? null,
          orderNumber: open.orderNumber ?? null,
          contactName: open.contact ?? null,
          recordedById: counterPickup ? adminId : uid(open.by as string),
          checkedOutById: counterPickup ? null : uid(open.by as string),
          checkoutMethod: counterPickup ? 'COUNTER_PICKUP' : 'TECH',
          checkoutDate: day(open.out),
          expectedReturnDate: day(open.due),
        })
        const rental = await tx.rental.create({
          data: {
            orgId: org.id,
            orderId,
            assetId: asset.id,
            customerId: customerIdByName.get(open.customer) ?? null,
            jobId: jobIdByName.get(open.job) ?? null,
            orderNumber: open.orderNumber ?? null,
            contactName: open.contact ?? null,
            recordedById: counterPickup ? adminId : uid(open.by as string),
            checkedOutById: counterPickup ? null : uid(open.by as string),
            checkoutMethod: counterPickup ? 'COUNTER_PICKUP' : 'TECH',
            checkoutDate: day(open.out),
            expectedReturnDate: day(open.due),
            checkoutCondition: 'GOOD',
            status: day(open.due) < TODAY ? 'OVERDUE' : 'OPEN',
          },
        })

        // Prisma can't write a tstzrange, so the window goes in via raw SQL.
        // This is what the GIST exclusion constraint actually reads.
        await tx.$executeRaw`
          UPDATE "Rental"
          SET period = tstzrange(${day(open.out)}, ${day(open.due)}, '[)')
          WHERE id = ${rental.id} AND "orgId" = ${org.id}
        `
      })
      openRentals++
    }
  }

  console.log(`Assets: ${ASSETS.length} (${openRentals} on rent, ${historyRentals} historical rentals)`)
  console.log(`\nSign in with any seeded email and the password: ${password}`)
  console.log('  ray@teksolv.com       Admin')
  console.log('  sam@teksolv.com       Supervisor')
  console.log('  dreyes@teksolv.com    Field technician')
  console.log('  audit@teksolv.com     Viewer')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())

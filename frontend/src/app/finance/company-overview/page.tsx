"use client"
import { Card, Statistic, Row, Col } from 'antd'
import { useEffect, useState } from 'react'
import { getJSON } from '../../../lib/api'

type Tx = { id: string; kind: 'income'|'expense'; amount: number }
type Order = { id: string; price?: number; cleaning_fee?: number }

export default function CompanyOverviewPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  useEffect(() => { getJSON<Order[]>('/orders').then(setOrders).catch(()=>setOrders([])); getJSON<Tx[]>('/finance').then(setTxs).catch(()=>setTxs([])) }, [])
  const income = orders.reduce((s,x)=> s + Number(x.price || 0), 0)
  const cleaning = orders.reduce((s,x)=> s + Number(x.cleaning_fee || 0), 0)
  const otherExp = txs.filter(t=>t.kind==='expense').reduce((s,x)=> s + Number(x.amount || 0), 0)
  const net = income - cleaning - otherExp
  return (
    <Card title="公司收益总览">
      <Row gutter={16}>
        <Col span={6}><Statistic title="租金总收入" value={income} precision={2} /></Col>
        <Col span={6}><Statistic title="清洁费" value={cleaning} precision={2} /></Col>
        <Col span={6}><Statistic title="其他支出" value={otherExp} precision={2} /></Col>
        <Col span={6}><Statistic title="净收益" value={net} precision={2} /></Col>
      </Row>
    </Card>
  )
}


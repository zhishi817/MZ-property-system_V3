import HomeHeader from '../home/HomeHeader'
import styles from './properties.module.css'

export default function Loading() {
  return (
    <div className={styles.loadingPage} aria-busy="true">
      <HomeHeader />
      <main>
        <section className={styles.loadingHero}>
          <div><h1>Loading properties…</h1><p>Preparing the published Melbourne collection.</p></div>
        </section>
        <div className={styles.loadingPanel} aria-hidden="true" />
      </main>
    </div>
  )
}
